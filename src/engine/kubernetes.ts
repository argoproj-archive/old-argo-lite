import { Observable, Observer } from 'rxjs';
import * as api from 'kubernetes-client';
import * as path from 'path';
import * as shell from 'shelljs';
import * as shellEscape from 'shell-escape';

import * as model from './model';
import { Executor, StepResult, WorkflowContext } from './common';
import * as utils from './utils';

export class KubernetesExecutor implements Executor {
    private core: api.Core;
    private podUpdates: Observable<any>;

    constructor(private configPath: string, private namespace: string, version = 'v1') {
        this.core = new api.Core(Object.assign({}, api.config.fromKubeconfig(api.config.loadKubeconfig(configPath)), {namespace, version, promises: true }));

        this.podUpdates = new Observable(observer =>
            utils.reactifyJsonStream(this.core.ns.pods.getStream({ qs: { watch: true } })).map(item => item.object).subscribe(observer),
        ).retry().share();
    }

    public executeContainerStep(step: model.WorkflowStep, context: WorkflowContext, inputArtifacts: {[name: string]: any}): Observable<StepResult> {
        return new Observable<StepResult>((observer: Observer<StepResult>) => {
            let stepPod = null;

            let cleanUp = async () => {
                if (stepPod) {
                    await this.core.ns.pods.delete({ name: stepPod.metadata.name });
                    stepPod = null;
                }
            };

            let execute = async () => {
                let result: StepResult = { status: model.TaskStatus.Waiting };

                function notify(update: StepResult) {
                    observer.next(Object.assign(result, update));
                }

                try {
                    let tempDir = path.join(shell.tempdir(), 'argo', step.id);
                    let artifactsDir = path.join(tempDir, 'artifacts');
                    shell.mkdir('-p', artifactsDir);

                    observer.next(Object.assign(result, { status: model.TaskStatus.Waiting }));
                    stepPod = await this.core.ns.pods.post({body: {
                        apiVersion: 'v1',
                        kind: 'Pod',
                        metadata: { name: step.id },
                        spec: {
                            containers: [{
                                name: 'step',
                                image: step.template.image,
                                command: ['sh', '-c'],
                                args: [
                                    `mkdir -p /__argo;
                                    until [ -f /__argo/artifacts_in ]; do echo downloading step artifacts; sleep 1; done;
                                    ${shellEscape(step.template.command.concat(step.template.args))};script_exit_code=$?;
                                    echo done > /__argo/step_done;
                                    until [ -f /__argo/artifacts_out ]; do echo uploading step artifacts; sleep 1; done;
                                    exit $script_exit_code`,
                                ],
                            }],
                            restartPolicy: 'Never',
                        },
                    }});

                    await this.podUpdates.filter(pod => pod.metadata.name === step.id && pod.status.phase !== 'Pending').first().toPromise();

                    let logs = utils.reactifyStringStream(this.core.ns.po(stepPod.metadata.name).log.getStream({ qs: { follow: true } }));
                    observer.next(Object.assign(result, { status: model.TaskStatus.Running }, logs));

                    await Promise.all(Object.keys(step.template.inputs.artifacts || {}).map(async artifactName => {
                        let inputArtifactPath = inputArtifacts[artifactName];
                        let artifact = step.template.inputs.artifacts[artifactName];
                        await this.runKubeCtl(['cp', inputArtifactPath, `${this.namespace}/${stepPod.metadata.name}:/__argo/`, '-c', 'step']);
                        await this.kubeCtlExec(stepPod, [`mv /__argo/${path.basename(inputArtifactPath)} ${artifact.path}`]);
                    }));

                    await this.kubeCtlExec(stepPod, ['echo done > /__argo/artifacts_in']);

                    let stepIsDone = false;
                    do {
                        let res = await this.kubeCtlExec(stepPod, ['ls', '/__argo/artifacts_in'], false);
                        stepIsDone = res.code === 0;
                    } while (!stepIsDone);

                    let artifacts = step.template.outputs && step.template.outputs.artifacts && await Promise.all(Object.keys(step.template.outputs.artifacts).map(async key => {
                        let artifact = step.template.outputs.artifacts[key];
                        let artifactPath = path.join(artifactsDir, key);
                        await this.runKubeCtl(['cp', `${this.namespace}/${stepPod.metadata.name}:${artifact.path}`, artifactPath, '-c', 'step']);
                        return { name: key, artifactPath };
                    })) || [];

                    let artifactsMap = {};
                    artifacts.forEach(item => artifactsMap[item.name] = item.artifactPath);

                    await this.kubeCtlExec(stepPod, ['echo done > /__argo/artifacts_out']);
                    let completedPod = await this.podUpdates.filter(pod => pod.metadata.name === step.id && this.isPodCompeleted(pod)).first().toPromise();
                    let logLines = await utils.reactifyStringStream(this.core.ns.po(stepPod.metadata.name).log.getStream({ qs: { follow: true } })).toArray().toPromise();

                    notify({
                        status: completedPod.status.phase === 'Succeeded' ? model.TaskStatus.Success : model.TaskStatus.Failed,
                        artifacts: artifactsMap,
                        logs: Observable.from(logLines),
                    });
                } finally {
                    await cleanUp();
                    observer.complete();
                }
            };

            execute().catch(e => observer.error(e));
            return cleanUp;
        });
    }

    private kubeCtlExec(stepPod: any, cmd: string[], rejectOnFail = true) {
        return this.runKubeCtl(['exec', `${stepPod.metadata.name}`, '--', 'sh', '-c'].concat(cmd), rejectOnFail);
    }

    private runKubeCtl(cmd: string[], rejectOnFail = true) {
        return utils.exec(['kubectl', `--kubeconfig=${this.configPath}`].concat(cmd), rejectOnFail);
    }

    private isPodCompeleted(pod) {
        return ['Succeeded', 'Failed', 'Unknown'].indexOf(pod.status.phase) > -1;
    }
}
