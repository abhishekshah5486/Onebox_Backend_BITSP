#!/usr/bin/env bash
# Builds images and deploys OneBox to a local minikube profile, loading secrets from .env.
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE=onebox
SERVICES=(auth accounts settings mail connector llm-proxy ai payments billing realtime search rag api-gateway)
CTX="$PROFILE"

minikube -p "$PROFILE" status >/dev/null 2>&1 ||
  minikube start -p "$PROFILE" --driver=docker --cpus=2 --memory=3000

for service in "${SERVICES[@]}"; do
  if [ -f "services/$service/Dockerfile" ]; then
    # Python services build from their own Dockerfile.
    docker build -q -t "onebox/$service:dev" "services/$service"
  else
    docker build -q --build-arg SERVICE="$service" -t "onebox/$service:dev" .
  fi
  minikube -p "$PROFILE" image load --overwrite "onebox/$service:dev"
done

kubectl --context "$CTX" apply -f deploy/k8s/namespace.yaml
kubectl --context "$CTX" -n onebox create secret generic onebox-secrets \
  --from-env-file=.env --dry-run=client -o yaml | kubectl --context "$CTX" apply -f -
kubectl --context "$CTX" apply -k deploy/k8s

for deployment in redis objects elasticsearch qdrant "${SERVICES[@]}"; do
  kubectl --context "$CTX" -n onebox rollout restart "deployment/$deployment"
  kubectl --context "$CTX" -n onebox rollout status "deployment/$deployment" --timeout=180s
done

echo "Gateway: kubectl --context $CTX -n onebox port-forward svc/api-gateway 4000:4000"
