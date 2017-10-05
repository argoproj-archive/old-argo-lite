import { Subject, Observable } from 'rxjs';

import * as model from './model';
import { Executor, StepResult, WorkflowContext, StepInput } from './common';

export class WorkflowOrchestrator {
    private readonly stepResultsQueue = new Subject<{id: string, taskId: string, result: StepResult}>();
    private readonly tasksProcessingQueue = new Subject<model.Task>();

    constructor(private executor: Executor) {
        this.tasksProcessingQueue.subscribe(async task => {
            try {
                await this.processStep(
                    task.id,
                    {id: task.id, template: task.template, arguments: task.arguments},
                    {workflow: null, results: {}},
                    {parameters: task.arguments, artifacts: {}});
            } catch (e) {
                this.stepResultsQueue.next({id: task.id, taskId: task.id, result: { status: model.TaskStatus.Failed, internalError: e }});
            }
        });
    }

    public getStepResults(): Observable<{id: string, taskId: string, result: StepResult}> {
        return this.stepResultsQueue;
    }

    public processTask(task: model.Task) {
        this.tasksProcessingQueue.next(task);
    }

    private processStep(taskId: string, step: model.WorkflowStep, parentContext: WorkflowContext, input: StepInput): Promise<StepResult> {
        switch (step.template.type) {
            case 'workflow':
                return this.processWorkflow(taskId, step, parentContext, input);
            case 'container':
                return this.processContainer(taskId, step, parentContext, input);
            default:
                throw new Error(`Type ${step.template.type} is not supported`);
        }
    }

    private async processWorkflow(taskId: string, workflow: model.WorkflowStep, parentContext: WorkflowContext, input: StepInput): Promise<StepResult> {
        input = this.processStepInput(workflow, parentContext, input);

        let result: StepResult = { status: model.TaskStatus.Running, artifacts: {} };
        this.stepResultsQueue.next({ result, id: workflow.id, taskId });

        let context: WorkflowContext = { workflow, results: {} };
        for (let parallelStepsGroup of workflow.template.steps) {
            let results = await Promise.all(
                Object.keys(parallelStepsGroup)
                .map(stepName => this.processStep(taskId, parallelStepsGroup[stepName], context, input).then(res => Object.assign(res, { name: stepName }))),
            );

            for (let stepResult of results) {
                context.results[stepResult.name] = stepResult;

                Object.keys(stepResult.artifacts || {}).forEach(artifactName => {
                    let matchingArtifactName = Object.keys((workflow.template.outputs || {}).artifacts || {}).find(key =>
                        workflow.template.outputs.artifacts[key].from === `%%steps.${stepResult.name}.outputs.artifacts.${artifactName}%%`);
                    if (matchingArtifactName) {
                        result.artifacts[matchingArtifactName] = stepResult.artifacts[artifactName];
                    }
                });
                if (stepResult.status === model.TaskStatus.Failed) {
                    result.status = model.TaskStatus.Failed;
                    this.stepResultsQueue.next({ result, id: workflow.id, taskId });
                }
            }
            if (result.status === model.TaskStatus.Failed) {
                break;
            }
        }
        if (result.status === model.TaskStatus.Running) {
            result.status = model.TaskStatus.Success;
            this.stepResultsQueue.next({ result, id: workflow.id, taskId });
        }
        return result;
    }

    private processContainer(taskId: string, container: model.WorkflowStep, parentContext: WorkflowContext, input: StepInput): Promise<StepResult> {
        input = this.processStepInput(container, parentContext, input);
        container.template.command = container.template.command.map(item => this.substituteInputParams(item, input.parameters));
        container.template.args = container.template.args.map(item => this.substituteInputParams(item, input.parameters));
        container.template.image = this.substituteInputParams(container.template.image, input.parameters);

        return this.executor.executeContainerStep(container, parentContext, input.artifacts)
            .do(result => this.stepResultsQueue.next({id: container.id, taskId, result}))
            .last().toPromise();
    }

    private processStepInput(step: model.WorkflowStep, parentContext: WorkflowContext, input: StepInput): StepInput {
        let parameters = {};
        Object.keys(step.arguments || {}).forEach(key => {
            parameters[key] = parentContext.workflow ? this.substituteInputParams(step.arguments[key], parentContext.workflow.arguments) : step.arguments[key];
        });
        let artifacts = {};
        Object.keys(step.arguments || {}).filter(name => name.startsWith('artifacts.')).forEach(name => {
            let stepsArtifactMatch = step.arguments[name].match(/%%steps\.([^\.]*)\.outputs\.artifacts\.([^%.]*)%%/);
            let inputsArtifactsMatch = step.arguments[name].match(/%%inputs\.artifacts\.([^%.]*)%%/);
            if (stepsArtifactMatch) {
                let [, stepName, artifactName] = stepsArtifactMatch;
                let stepResult = parentContext.results[stepName];
                if (!stepResult) {
                    throw new Error(`Step requires output artifact of step '${stepName}', but step result is not available`);
                }
                artifacts[artifactName] = (stepResult.artifacts || {})[artifactName];
            } else if (inputsArtifactsMatch) {
                let [, artifactName] = inputsArtifactsMatch;
                let artifact = input.artifacts[artifactName];
                if (!artifact) {
                    throw new Error(`Step requires input artifact'${artifactName}', but artifact is not available`);
                }
                artifacts[artifactName] = artifact;
            } else {
                throw new Error(`Unable to parse artifacts input: '${step.arguments[name]}'`);
            }
        });
        return { parameters, artifacts };
    }

    private substituteInputParams(src: string, args: {[name: string]: string}) {
        Object.keys(args).filter(key => key.startsWith('parameters.')).forEach(key => {
            src = src.replace(`%%inputs.${key}%%`, args[key]);
        });
        return src;
    }
}
