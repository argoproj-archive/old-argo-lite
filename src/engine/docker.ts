import * as shell from 'shelljs';
import * as shellEscape from 'shell-escape';
import * as path from 'path';
import * as fs from 'fs';
import { Observable, Observer } from 'rxjs';
import { Docker } from 'node-docker-api';

import * as model from './model';
import { Executor, StepResult, WorkflowContext } from './common';

function reactifyStream(stream, converter = item => item) {
    return new Observable((observer: Observer<string>) => {
        stream.on('data', (d) => observer.next(converter(d)));
        stream.on('end', () => observer.complete());
        stream.on('error', e => observer.error(e));
    });
}

function reactifyStringStream(stream) {
    return reactifyStream(stream, item => item.toString());
}

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
                        await this.shell(['docker', 'cp', inputArtifactPath, `${container.id}:${artifact.path}`], false);
                    }));

                    notify({ status: model.TaskStatus.Running });

                    await container.start();

                    let logs = await reactifyStringStream(await container.logs({ stdout: true, stderr: true, follow: true })).share();
                    notify({ logs });

                    let status = await container.wait();

                    let logLines = await logs.toArray().toPromise();
                    fs.writeFileSync(path.join(tempDir, 'logs'), logLines.join(''));
                    notify({ logs: Observable.from(logLines) });
                    let artifacts = step.template.outputs && step.template.outputs.artifacts && await Promise.all(Object.keys(step.template.outputs.artifacts).map(async key => {
                        let artifact = step.template.outputs.artifacts[key];
                        let artifactPath = path.join(artifactsDir, key);
                        await this.shell(['docker', 'cp', `${container.id}:${artifact.path}`, artifactPath], false);
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

    private shell(cmd: string[], rejectOnFail = true): Promise<any> {
        return new Promise((resolve, reject) => {
            shell.exec(shellEscape(cmd), (code, stdout, stderr) => {
                if (code !== 0 && rejectOnFail) {
                    reject(stdout + stderr);
                } else {
                    resolve();
                }
            });
        });
    }
}
