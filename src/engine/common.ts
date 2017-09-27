import { Observable } from 'rxjs';
import * as model from './model';

export interface WorkflowContext {
    workflow: model.WorkflowStep;
    results: {[name: string]: StepResult};
}

export interface StepResult {
    status?: model.TaskStatus;
    logs?: Observable<string>;
    artifacts?: { [name: string]: any };
    internalError?: string;
}

export interface TaskResult {
    task: model.Task;
    stepResults: { [id: string]: StepResult };
}

export interface Executor {
    executeContainerStep(step: model.WorkflowStep, context: WorkflowContext, inputArtifacts: {[name: string]: any}): Observable<StepResult>;
}
