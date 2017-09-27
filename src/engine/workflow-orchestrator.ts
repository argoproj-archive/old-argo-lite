import { Subject, Observable } from 'rxjs';

import * as model from './model';
import { Executor, StepResult, WorkflowContext } from './common';

export class WorkflowOrchestrator {
    private readonly stepResultsQueue = new Subject<{id: string, taskId: string, result: StepResult}>();
    private readonly tasksProcessingQueue = new Subject<model.Task>();

    constructor(private executor: Executor) {
        this.tasksProcessingQueue.subscribe(async task => {
            try {
                await this.processStep(task.id, {id: task.id, template: task.template, arguments: task.arguments}, { workflow: null, results: {} });
            } catch (e) {
                this.stepResultsQueue.next({id: task.id, taskId: task.id, result: { status: model.TaskStatus.Failed, internalError: e.toString() }});
            }
        });
    }

    public getStepResults(): Observable<{id: string, taskId: string, result: StepResult}> {
        return this.stepResultsQueue;
    }

    public processTask(task: model.Task) {
        this.tasksProcessingQueue.next(task);
    }

    private processStep(taskId: string, step: model.WorkflowStep, parentContext: WorkflowContext): Promise<StepResult> {
        switch (step.template.type) {
            case 'workflow':
                return this.processWorkflow(taskId, step, parentContext);
            case 'container':
                return this.processContainer(taskId, step, parentContext);
            default:
                throw new Error(`Type ${step.template.type} is not supported`);
        }
    }

    private async processWorkflow(taskId: string, workflow: model.WorkflowStep, parentContext: WorkflowContext): Promise<StepResult> {
        workflow.arguments = this.getSubstitutedStepParams(workflow, parentContext);

        let result: StepResult = { status: model.TaskStatus.Running, artifacts: {} };
        this.stepResultsQueue.next({ result, id: workflow.id, taskId });

        let context: WorkflowContext = { workflow, results: {} };
        for (let parallelStepsGroup of workflow.template.steps) {
            let results = await Promise.all(
                Object.keys(parallelStepsGroup)
                .map(stepName => this.processStep(taskId, parallelStepsGroup[stepName], context).then(res => Object.assign(res, { name: stepName })))
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

    private processContainer(taskId: string, container: model.WorkflowStep, parentContext: WorkflowContext): Promise<StepResult> {
        let parameters = this.getSubstitutedStepParams(container, parentContext);
        let artifacts = this.resolveInputArtifacts(container, parentContext);
        container.template.command = container.template.command.map(item => this.substituteInputParams(item, parameters));
        container.template.args = container.template.args.map(item => this.substituteInputParams(item, parameters));
        container.template.image = this.substituteInputParams(container.template.image, parameters);

        return this.executor.executeContainerStep(container, parentContext, artifacts)
            .do(result => this.stepResultsQueue.next({id: container.id, taskId, result}))
            .last().toPromise();
    }

    private getSubstitutedStepParams(step: model.WorkflowStep, parentContext: WorkflowContext) {
        let parameters = {};
        Object.keys(step.arguments).forEach(key => {
            parameters[key] = parentContext.workflow ? this.substituteInputParams(step.arguments[key], parentContext.workflow.arguments) : step.arguments[key];
        });
        return parameters;
    }

    private substituteInputParams(src: string, args: {[name: string]: string}) {
        Object.keys(args).filter(key => key.startsWith('parameters.')).forEach(key => {
            src = src.replace(`%%inputs.${key}%%`, args[key]);
        });
        return src;
    }

    private resolveInputArtifacts(container: model.WorkflowStep, parentContext: WorkflowContext) {
        let artifacts = {};
        Object.keys(container.arguments || {}).filter(name => name.startsWith('artifacts.')).forEach(name => {
            let match = container.arguments[name].match(/%%steps\.([^\.]*)\.outputs\.artifacts\.([^%.]*)%%/);
            if (match) {
                let [, stepName, artifactName] = match;
                let stepResult = parentContext.results[stepName];
                if (!stepResult) {
                    throw new Error(`Step requires output artifact of step '${stepName}', but step result is not available`);
                }
                artifacts[artifactName] = (stepResult.artifacts || {})[artifactName];
            } else {
                throw new Error(`Unable to parse artifacts input: '${container.arguments[name]}'`);
            }
        });
        return artifacts;
    }
}
