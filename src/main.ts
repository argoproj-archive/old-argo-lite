import { Observable } from 'rxjs';
import * as express from 'express';
import * as yargs from 'yargs';
import * as bodyParser from 'body-parser';
import * as engine from './engine';

let executor: engine.Executor = null;

let argv = yargs
    .option('e', {
        alias: 'engine',
        describe: 'Container executor engine',
        choices: ['docker', 'kubernetes', 'kubernetes-in-cluster'],
        default: 'docker',
    }).argv;

if (argv.engine === 'docker') {
    console.info('Using docker as container executor');
    executor = new engine.DockerExecutor();
} else if (argv.engine === 'kubernetes') {
    argv = yargs
        .option('c', {alias: 'config', describe: 'Kubernetes config file path', demand: true })
        .option('n', {alias: 'namespace', describe: 'Existing kubernetes namespace', default: 'default'}).argv;
    console.info(`Using kubernetes as container executor: config path: ${argv.config}, namespace ${argv.namespace}`);
    executor = engine.KubernetesExecutor.fromConfigFile(argv.config, argv.namespace);
} else if (argv.engine === 'kubernetes-in-cluster') {
    console.info('Using kubernetes as container executor assuming argo is running inside the cluster');
    executor = engine.KubernetesExecutor.inCluster();
}

let workflowEngine = new engine.WorkflowEngine(executor);

let app = express();
app.use(bodyParser.json());

function streamServerEvents<T>(req: express.Request, res: express.Response, source: Observable<T>, formatter: (input: T) => string) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    let subscription = source.subscribe(
        (info) => res.write(`data:${formatter(info)}\n\n`),
        (err) => res.end(),
        () => res.end());
    req.on('close', () => subscription.unsubscribe());
}

app.post('/v1/auth/login', (req, res) => res.send({session: 'test'}));
app.get('/v1/auth/schemes', (req, res) => res.send({data: [{enabled: true, name: 'native'}]}));
app.get('/v1/users/session', (req, res) => res.send(
    {id: 'test', username: 'test', state: 2, auth_schemes: ['native'], groups: ['developer'], settings: null, view_preferences: {isIntroductionCompleted: 'true'}, labels: []},
));
app.get('/v1/system/version', (req, res) => res.send({namespace: 'axsys', version: '1.1.0', cluster_id: 'test'}));
app.get('/v1/branches', (req, res) => res.send({data: []}));
app.get('/v1/repos', (req, res) => res.send({data: []}));
app.get('/v1/tools', (req, res) => res.send({data: []}));
app.get('/v1/notification_center/events', (req, res) => res.send({data: []}));
app.get('/v1/commits', (req, res) => res.send({data: []}));
app.get('/v1/templates', (req, res) => res.send({data: []}));
app.get('/v1/templates/:id', (req, res) => res.send({}));

app.post('/v1/services', async (req, res) => {
    let task = await workflowEngine.launch(req.body.template, req.body.arguments);
    res.send(task);
});

app.get('/v1/services', (req, res) => res.send({data: workflowEngine.getTasks() }));

app.get('/v1/services/:id', (req, res) => {
    let task = workflowEngine.getTaskById(req.params.id);
    if (task) {
        res.send(task);
    } else {
        res.status(404).send('Error');
    }
});

app.get('/v1/services/:id/logs', (req, res) => {
    let logs = workflowEngine.getStepLogs(req.params.id);
    if (logs) {
        streamServerEvents(req, res, logs, line => JSON.stringify({ log: line }));
    } else {
        res.status(404).send('Error');
    }
});

app.get('/v1/service/events', (req, res) => streamServerEvents(req, res, workflowEngine.getServiceEvents(), event => JSON.stringify(event)));
app.get('/v1/services/:id/events', (req, res) => streamServerEvents(req, res, workflowEngine.getServiceEvents(req.params.id), event => JSON.stringify(event)));

app.listen(8080);
