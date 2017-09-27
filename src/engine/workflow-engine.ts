import { Observable } from 'rxjs';
import * as moment from 'moment';
import * as uuid from 'uuid';
import { WorkflowOrchestrator } from './workflow-orchestrator';
import { Executor, TaskResult, StepResult } from './common';
import * as model from './model';

export class WorkflowEngine {
    private orchestrator: WorkflowOrchestrator;
    private taskResultsById = new Map<string, TaskResult>();
    private stepResultsById = new Map<string, StepResult>();

    constructor(private executor: Executor) {
        this.orchestrator = new WorkflowOrchestrator(executor);
        this.orchestrator.getStepResults().subscribe(res => {
            this.stepResultsById.set(res.id, res.result);
            let taskResult = this.taskResultsById.get(res.taskId);
            let rootTask = taskResult.task;
            if (res.id === res.taskId) {
                 this.updateTaskStatus(rootTask, res.result);
             } else {
                 let childStep = rootTask.children.find(child => child.id === res.id);
                 this.updateTaskStatus(childStep, res.result);
             }
        });
    }

    public getServiceEvents(taskId?: string): Observable<model.TaskEvent> {
        let events = this.orchestrator.getStepResults().map(res => ({ task_id: res.taskId, id: res.id, status: res.result.status }));
        if (taskId) {
            events = events.filter(event => event.task_id === taskId);
        }
        return events;
    }

    public async launch(template: model.Template, args: {[name: string]: string}): Promise<model.Task> {
        let task = this.constructTask(template, args);
        this.taskResultsById.set(task.id, { task, stepResults: {} });
        this.orchestrator.processTask(task);
        return task;
    }

    public getTaskById(id: string) {
        let result = this.taskResultsById.get(id);
        return result && result.task || null;
    }

    public getTasks(): model.Task[] {
        return Array.from(this.taskResultsById.values()).map(item => item.task).sort((first, second) => second.create_time - first.create_time);
    }

    public getStepLogs(id: string): Observable<string> {
        let stepResult = this.stepResultsById.get(id);
        return stepResult && stepResult.logs;
    }

    private constructTask(template: model.Template, args: {[name: string]: string}): model.Task {
        let id = uuid();
        let task: model.Task = {
            id, name: template.name, template, arguments: args, launch_time: 0, create_time: moment().unix(), task_id: id, commit: {}, artifact_tags: '' };
        task.children = [];
        let childGroups = (task.template.steps || []).slice();
        while (childGroups.length > 0) {
            let group = childGroups.pop();
            Object.keys(group).forEach(stepName => {
                let step = group[stepName];
                step.id = uuid();
                let stepTask: model.Task = { id: step.id, template: step.template, launch_time: 0, create_time: moment().unix(), status: model.TaskStatus.Init };
                task.children.push(stepTask);
                if (step.template.steps) {
                    childGroups = childGroups.concat(step.template.steps);
                }
            });
        }
        return task;
    }

    private updateTaskStatus(task: model.Task, stepResult: StepResult) {
        task.status = stepResult.status;
        if (task.status === stepResult.status) {
            switch (stepResult.status) {
                case model.TaskStatus.Running:
                    task.launch_time = moment().unix();
                    break;
                default:
                    task.run_time = moment().unix() - (task.launch_time || task.create_time);
                    break;
            }
            task['status_detail'] = {
                code: this.getStatusCode(stepResult.status),
                message: stepResult.internalError,
            };
        }
    }

    private getStatusCode(status: model.TaskStatus): string {
        switch (status) {
            case model.TaskStatus.Skipped: return 'Skipped';
            case model.TaskStatus.Cancelled: return 'Cancelled';
            case model.TaskStatus.Failed: return 'Failed';
            case model.TaskStatus.Success: return 'Success';
            case model.TaskStatus.Waiting: return 'Waiting';
            case model.TaskStatus.Running: return 'Running';
            case model.TaskStatus.Canceling: return 'Canceling';
            case model.TaskStatus.Init: return 'Init';
            default: return '';
        }
    }
}
