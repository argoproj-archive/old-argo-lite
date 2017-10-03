import * as shell from 'shelljs';
import * as path from 'path';
import * as fs from 'fs';
import { Observable, Observer } from 'rxjs';
import { Docker } from 'node-docker-api';

import * as model from './model';
import * as utils from './utils';
import { Executor, StepResult, WorkflowContext } from './common';

export class DockerExecutor implements Executor {

    private docker;

    constructor() {
        this.docker = new Docker({ socketPath: '/var/run/docker.sock' });
    }

    public executeContainerStep(step: model.WorkflowStep, context: WorkflowContext, inputArtifacts: {[name: string]: any}): Observable<StepResult> {
        return new Observable<StepResult>((observer: Observer<StepResult>) => {
            let container = null;
            let result: StepResult = { status: model.TaskStatus.Waiting };

            function notify(update: StepResult) {
                observer.next(Object.assign(result, update));
            }

            async function cleanUpContainer() {
                if (container) {
                    await container.delete({ force: true });
                    container = null;
                }
            }

            let execute = async () => {
                container = await this.docker.container.create({ Image: step.template.image, Cmd: step.template.command.concat(step.template.args) });

                let tempDir = path.join(shell.tempdir(), 'argo', step.id);
                let artifactsDir = path.join(tempDir, 'artifacts');
                shell.mkdir('-p', artifactsDir);
                try {

                    await Promise.all(Object.keys(step.template.inputs.artifacts || {}).map(async artifactName => {
                        let inputArtifactPath = inputArtifacts[artifactName];
                        let artifact = step.template.inputs.artifacts[artifactName];
                        await utils.exec(['docker', 'cp', inputArtifactPath, `${container.id}:${artifact.path}`], false);
                    }));

                    notify({ status: model.TaskStatus.Running });

                    await container.start();

                    let logs = await utils.reactifyStringStream(await container.logs({ stdout: true, stderr: true, follow: true })).share();
                    notify({ logs });

                    let status = await container.wait();

                    let logLines = await logs.toArray().toPromise();
                    fs.writeFileSync(path.join(tempDir, 'logs'), logLines.join(''));
                    notify({ logs: Observable.from(logLines) });
                    let artifacts = step.template.outputs && step.template.outputs.artifacts && await Promise.all(Object.keys(step.template.outputs.artifacts).map(async key => {
                        let artifact = step.template.outputs.artifacts[key];
                        let artifactPath = path.join(artifactsDir, key);
                        await utils.exec(['docker', 'cp', `${container.id}:${artifact.path}`, artifactPath]);
                        return { name: key, artifactPath };
                    })) || [];
                    let artifactsMap = {};
                    artifacts.forEach(item => artifactsMap[item.name] = item.artifactPath);
                    notify({ status: status.StatusCode === 0 ? model.TaskStatus.Success : model.TaskStatus.Failed, artifacts: artifactsMap });
                } finally {
                    await cleanUpContainer();
                    observer.complete();
                }
            };

            execute().catch(e => observer.error(e));
            return cleanUpContainer;
        });
    }
}
