import { Observable } from 'rxjs';
import * as model from './model';

export interface WorkflowContext {
    workflow: model.WorkflowStep;
    results: {[name: string]: StepResult};
}

export interface StepResult {
    // Executor specific step id.
    stepId?: string;
    status?: model.TaskStatus;
    // Path to file with logs. Should be available after step is completed.
    logsPath?: string;
    // Artifacts paths by name
    artifacts?: { [name: string]: string };
    internalError?: string;
}

export interface Executor {
    executeContainerStep(step: model.WorkflowStep, context: WorkflowContext, inputArtifacts: {[name: string]: string}): Observable<StepResult>;
    getLiveLogs(containerId: string): Observable<string>;
}
