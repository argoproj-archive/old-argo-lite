# argo-lite

Argo-lite is lightweight workflow engine implementation compatible with [Argo](https://github.com/argoproj/argo) YAML. Argo-lite executes workflow defined using [Argo YAML](https://argoproj.github.io/argo-site/docs/yaml/dsl_reference_intro.html) using Docker or Kubernetes. It exposes same APIs as [Argo](https://github.com/argoproj/argo) so project is
compatible with [Argo Dev CLI](https://argoproj.github.io/argo-site/docs/dev-cli-reference.html) and Argo UI.

## Argo-lite is in active development state.

Several features or argo workflow engine are not yet supported, engine is not fully tested and might crash but early testing/contributions are very very welcome.

- [x] ~~Kubernetes integration~~
- [ ] API to access artifacts
- [ ] [Dynamic fixtures](https://argoproj.github.io/argo-site/docs/yaml/fixture_template.html)
- [ ] add Argo UI into Argo-lite distribution
- [ ] [Docker-in-Docker](https://argoproj.github.io/argo-site/docs/yaml/argo_tutorial_2_create_docker_image_build_workflow.html)
- [ ] unit/e2e tests

## Why?

Argo-lite might be used to debug Argo workflows locally on your laptop or to quicky get experience of [Argo](https://github.com/argoproj/argo) without full cluster deployment.

## Deploy it:

1. Run argo-lite locally using docker as workflow step executor:

```
docker run --rm -p 8080:8080  -v /var/run/docker.sock:/var/run/docker.sock -dt docker.io/alexmt/argo-lite node /app/dist/main.js
```

2. Run argo-lite locally using remote kubernetes cluster as workflow step executor:

```
docker run --rm -p 8080:8080 -v <path-to-your-kube-config>:/cluster.conf -it docker.io/alexmt/argo-lite node /app/dist/main.js --engine kubernetes --config /cluster.conf
```

3. Deploy argo-lite to your kubernetes cluster using same cluster as workflow step executor:

```
git clone git@github.com:alexmt/argo-lite.git && cd argo-lite && kubectl create -f argo-lite.yaml
```

## Try it:

Install and configure [Argo Dev CLI](https://argoproj.github.io/argo-site/docs/dev-cli-reference.html) and build argo-lite using argo-lite :

```
argo job submit checkout-build --config mini --local
```

![alt text](./demo.gif "Logo Title Text 1")
