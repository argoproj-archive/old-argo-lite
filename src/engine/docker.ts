import * as shell from 'shelljs';
import * as path from 'path';
import * as fs from 'fs';
import { Observable, Observer } from 'rxjs';
import { Docker } from 'node-docker-api';

import * as model from './model';
import * as utils from './utils';
import { Executor, StepResult, WorkflowContext } from './common';

export class DockerExecutor implements Executor {

    private docker: Docker;

    constructor() {
        this.docker = new Docker({ socketPath: '/var/run/docker.sock' });
    }

    public executeContainerStep(step: model.WorkflowStep, context: WorkflowContext, inputArtifacts: {[name: string]: string}): Observable<StepResult> {
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
                try {
                    await this.ensureImageExists(step.template.image);

                    container = await this.docker.container.create({ image: step.template.image, cmd: step.template.command.concat(step.template.args)});

                    let tempDir = path.join(shell.tempdir(), 'argo', step.id);
                    let artifactsDir = path.join(tempDir, 'artifacts');
                    shell.mkdir('-p', artifactsDir);

                    await Promise.all(Object.keys(step.template.inputs.artifacts || {}).map(async artifactName => {
                        let inputArtifactPath = inputArtifacts[artifactName];
                        let artifact = step.template.inputs.artifacts[artifactName];
                        await utils.exec(['docker', 'cp', inputArtifactPath, `${container.id}:${artifact.path}`], false);
                    }));

                    notify({ status: model.TaskStatus.Running, stepId: container.id });

                    await container.start();

                    let status = await container.wait();

                    let logLines = await this.getContainerLogs(container).toArray().toPromise();
                    let logsPath = path.join(tempDir, 'logs');
                    fs.writeFileSync(logsPath, logLines.join(''));

                    notify({ logsPath });

                    let artifacts = step.template.outputs && step.template.outputs.artifacts && await Promise.all(Object.keys(step.template.outputs.artifacts).map(async key => {
                        let artifact = step.template.outputs.artifacts[key];
                        let artifactPath = path.join(artifactsDir, key);
                        await utils.exec(['docker', 'cp', `${container.id}:${artifact.path}`, artifactPath], false);
                        return { name: key, artifactPath };
                    })) || [];
                    let artifactsMap = {};
                    artifacts.forEach(item => artifactsMap[item.name] = item.artifactPath);
                    notify({ status: status.StatusCode === 0 ? model.TaskStatus.Success : model.TaskStatus.Failed, artifacts: artifactsMap });
                } catch (e) {
                    notify({ status: model.TaskStatus.Failed, internalError: e.toString() });
                } finally {
                    await cleanUpContainer();
                    observer.complete();
                }
            };

            execute();
            return cleanUpContainer;
        });
    }

    public getLiveLogs(containerId: string): Observable<string> {
        return this.getContainerLogs(this.docker.container.get(containerId));
    }

    private getContainerLogs(container): Observable<string> {
        return Observable.fromPromise(container.logs({ stdout: true, stderr: true, follow: true })).flatMap(stream => utils.reactifyStringStream(stream));
    }

    private async ensureImageExists(imageUrl: string): Promise<any> {
        let res = await await this.docker.image.list({filter: imageUrl});
        if (res.length === 0) {
            await utils.exec(['docker', 'pull', imageUrl]);
        }
    }
}
