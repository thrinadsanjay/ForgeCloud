#!/usr/bin/env bash
#
# k3s-forge-node-setup.sh
#
# Prepare a K3s node for Forge private-cloud:
#   1) Ensure K3s is installed and the API is Ready
#   2) Configure firewalld for Flannel CNI + Traefik Ingress
#   3) Create a permanent cluster-admin ServiceAccount token for Forge
#   4) Optionally tune Traefik (nativeLB) and print Forge Settings values
#
# Usage (on the K3s node, as root):
#   sudo bash k3s-forge-node-setup.sh
#   sudo bash k3s-forge-node-setup.sh --username forge-admin
#   sudo bash k3s-forge-node-setup.sh --skip-install          # K3s already installed
#   sudo bash k3s-forge-node-setup.sh --disable-firewalld    # lab: stop firewalld instead
#   sudo bash k3s-forge-node-setup.sh --skip-traefik-nativelb
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults / args
# ---------------------------------------------------------------------------
USERNAME="forge-admin"
INSTALL_K3S=1
CONFIGURE_FIREWALL=1
DISABLE_FIREWALLD=0
TRAEFIK_NATIVELB=1
WAIT_SECS=180

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --username) USERNAME="${2:?}"; shift 2 ;;
    --skip-install) INSTALL_K3S=0; shift ;;
    --disable-firewalld) DISABLE_FIREWALLD=1; CONFIGURE_FIREWALL=0; shift ;;
    --skip-firewall) CONFIGURE_FIREWALL=0; shift ;;
    --skip-traefik-nativelb) TRAEFIK_NATIVELB=0; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1" >&2; usage ;;
  esac
done

SECRET_NAME="${USERNAME}-permanent-token"
BINDING_NAME="${USERNAME}-binding"

# ---------------------------------------------------------------------------
# Pretty output
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
  C_RST='\033[0m'; C_BOLD='\033[1m'; C_DIM='\033[2m'
  C_OK='\033[32m'; C_WARN='\033[33m'; C_ERR='\033[31m'; C_INFO='\033[36m'
else
  C_RST=''; C_BOLD=''; C_DIM=''; C_OK=''; C_WARN=''; C_ERR=''; C_INFO=''
fi

step=0
section() {
  step=$((step + 1))
  echo
  echo -e "${C_BOLD}════════════════════════════════════════════════════════${C_RST}"
  echo -e "${C_BOLD}  Step ${step}: $*${C_RST}"
  echo -e "${C_BOLD}════════════════════════════════════════════════════════${C_RST}"
}
info()  { echo -e "  ${C_INFO}→${C_RST} $*"; }
ok()    { echo -e "  ${C_OK}✓${C_RST} $*"; }
warn()  { echo -e "  ${C_WARN}!${C_RST} $*"; }
fail()  { echo -e "  ${C_ERR}✗ $*${C_RST}" >&2; exit 1; }
die()   { fail "$*"; }

need_root() {
  [[ "$(id -u)" -eq 0 ]] || die "Run as root (sudo)."
}

have_cmd() { command -v "$1" >/dev/null 2>&1; }

kubectl() {
  if have_cmd k3s; then
    k3s kubectl "$@"
  else
    command kubectl "$@"
  fi
}

node_ip() {
  # Prefer the address clients will use for the K3s API / Traefik LB.
  local ip
  ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' || true)"
  if [[ -z "${ip}" ]]; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  echo "${ip}"
}

wait_for() {
  local desc="$1" timeout="$2"
  shift 2
  local start now
  start="$(date +%s)"
  info "Waiting for ${desc} (up to ${timeout}s)…"
  while true; do
    if "$@"; then
      ok "${desc}"
      return 0
    fi
    now="$(date +%s)"
    if (( now - start >= timeout )); then
      die "Timed out waiting for ${desc}"
    fi
    sleep 2
  done
}

k3s_api_ready() {
  kubectl get --raw=/readyz >/dev/null 2>&1
}

node_ready() {
  local s
  s="$(kubectl get nodes -o jsonpath='{.items[0].status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
  [[ "${s}" == "True" ]]
}

iface_up() {
  ip link show "$1" >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# 0. Preconditions
# ---------------------------------------------------------------------------
need_root

echo
echo -e "${C_BOLD}Forge · K3s node setup${C_RST}"
echo -e "${C_DIM}Host: $(hostname -f 2>/dev/null || hostname)  ·  $(date -Is)${C_RST}"

# ---------------------------------------------------------------------------
# 1. Install / start K3s
# ---------------------------------------------------------------------------
section "Install and start K3s"

if have_cmd k3s && systemctl is-active --quiet k3s 2>/dev/null; then
  ok "K3s is already installed and running"
elif [[ "${INSTALL_K3S}" -eq 1 ]]; then
  if ! have_cmd k3s; then
    info "Installing K3s (official install script)…"
    curl -sfL https://get.k3s.io | sh -
    ok "K3s installed"
  else
    info "Starting existing K3s service…"
    systemctl enable --now k3s
  fi
else
  have_cmd k3s || die "K3s not found. Re-run without --skip-install, or install K3s first."
  systemctl enable --now k3s
fi

systemctl is-active --quiet k3s || die "K3s service is not active"
wait_for "Kubernetes API (/readyz)" "${WAIT_SECS}" k3s_api_ready
wait_for "Node Ready" "${WAIT_SECS}" node_ready

# ---------------------------------------------------------------------------
# 2. Firewall
# ---------------------------------------------------------------------------
section "Configure firewall for Flannel + Traefik"

if [[ "${DISABLE_FIREWALLD}" -eq 1 ]]; then
  if systemctl is-active --quiet firewalld 2>/dev/null; then
    info "Disabling firewalld (lab mode)…"
    systemctl disable --now firewalld
    ok "firewalld stopped and disabled"
  else
    ok "firewalld is not running"
  fi
elif [[ "${CONFIGURE_FIREWALL}" -eq 1 ]]; then
  if ! systemctl is-active --quiet firewalld 2>/dev/null; then
    warn "firewalld is not active — starting it so rules persist"
    systemctl enable --now firewalld || warn "Could not start firewalld; skipping firewall config"
  fi

  if systemctl is-active --quiet firewalld 2>/dev/null; then
    info "Opening K3s / Flannel / Ingress ports…"
    firewall-cmd --permanent --add-port=8472/udp   # Flannel VXLAN (pod↔pod)
    firewall-cmd --permanent --add-port=6443/tcp   # Kubernetes API
    firewall-cmd --permanent --add-port=10250/tcp  # kubelet
    firewall-cmd --permanent --add-port=80/tcp     # Traefik HTTP
    firewall-cmd --permanent --add-port=443/tcp    # Traefik HTTPS
    firewall-cmd --permanent --add-masquerade

    info "Reloading firewalld…"
    firewall-cmd --reload
    ok "Ports and masquerade applied"

    # cni0 / flannel.1 appear only after CNI is up — wait, then trust them.
    info "Waiting for CNI interfaces (cni0, flannel.1)…"
    wait_for "interface cni0" 120 iface_up cni0
    wait_for "interface flannel.1" 120 iface_up flannel.1

    info "Trusting CNI interfaces (required — port opens alone are not enough)…"
    firewall-cmd --permanent --zone=trusted --add-interface=cni0 || true
    firewall-cmd --permanent --zone=trusted --add-interface=flannel.1 || true
    firewall-cmd --reload
    ok "cni0 and flannel.1 in trusted zone"

    info "Restarting K3s so CNI picks up firewall changes…"
    systemctl restart k3s
    wait_for "Kubernetes API after restart" "${WAIT_SECS}" k3s_api_ready
    wait_for "Node Ready after restart" "${WAIT_SECS}" node_ready
    ok "Firewall + CNI path configured"
  fi
else
  warn "Skipping firewall configuration (--skip-firewall)"
fi

# ---------------------------------------------------------------------------
# 3. Forge ServiceAccount + permanent token
# ---------------------------------------------------------------------------
section "Create Forge API ServiceAccount (${USERNAME})"

info "Ensuring ServiceAccount ${USERNAME} exists…"
kubectl create serviceaccount "${USERNAME}" \
  --dry-run=client -o yaml | kubectl apply -f -
ok "ServiceAccount ready"

info "Binding cluster-admin → default:${USERNAME}…"
kubectl create clusterrolebinding "${BINDING_NAME}" \
  --clusterrole=cluster-admin \
  --serviceaccount="default:${USERNAME}" \
  --dry-run=client -o yaml | kubectl apply -f -
ok "ClusterRoleBinding ready"

info "Creating permanent token Secret ${SECRET_NAME}…"
kubectl apply -f - <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: ${SECRET_NAME}
  namespace: default
  annotations:
    kubernetes.io/service-account.name: "${USERNAME}"
type: kubernetes.io/service-account-token
EOF

info "Waiting for token data to be populated…"
TOKEN=""
for _ in $(seq 1 30); do
  TOKEN="$(kubectl get secret "${SECRET_NAME}" -n default -o jsonpath='{.data.token}' 2>/dev/null | base64 -d 2>/dev/null || true)"
  if [[ -n "${TOKEN}" ]]; then
    break
  fi
  sleep 1
done
[[ -n "${TOKEN}" ]] || die "Token was not generated in Secret ${SECRET_NAME}"
ok "Permanent API token ready"

# ---------------------------------------------------------------------------
# 4. Traefik nativeLB (helps when CNI is flaky; safe with healthy CNI too)
# ---------------------------------------------------------------------------
section "Traefik Ingress defaults"

if [[ "${TRAEFIK_NATIVELB}" -eq 1 ]]; then
  info "Waiting for Traefik deployment…"
  if kubectl -n kube-system get deploy traefik >/dev/null 2>&1; then
    kubectl -n kube-system rollout status deploy/traefik --timeout=180s || warn "Traefik rollout still progressing"
    info "Enabling providers.kubernetesingress.nativelbbydefault…"
    kubectl apply -f - <<'EOF'
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik
  namespace: kube-system
spec:
  valuesContent: |-
    additionalArguments:
      - "--providers.kubernetesingress.nativelbbydefault=true"
EOF
    info "Waiting for Traefik to pick up HelmChartConfig…"
    sleep 8
    kubectl -n kube-system rollout status deploy/traefik --timeout=180s || warn "Traefik may still be restarting"
    ok "Traefik nativeLB-by-default configured"
  else
    warn "Traefik deployment not found yet — skip or re-run later"
  fi
else
  warn "Skipping Traefik nativeLB (--skip-traefik-nativelb)"
fi

# ---------------------------------------------------------------------------
# 5. Sanity checks
# ---------------------------------------------------------------------------
section "Verify cluster health"

API_IP="$(node_ip)"
API_URL="https://${API_IP}:6443"

info "Cluster nodes:"
kubectl get nodes -o wide || true
echo
info "Core system pods:"
kubectl get pods -n kube-system -o wide || true
echo

if iface_up cni0 && iface_up flannel.1; then
  ok "CNI interfaces present (cni0, flannel.1)"
else
  warn "CNI interfaces missing — Ingress may return 502 until Flannel is healthy"
fi

if ss -ulpn 2>/dev/null | grep -q ':8472'; then
  ok "Flannel VXLAN listening on UDP 8472"
else
  warn "UDP 8472 not listening — check Flannel / firewalld"
fi

TRAEFIK_LB="$(kubectl -n kube-system get svc traefik -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)"
if [[ -n "${TRAEFIK_LB}" ]]; then
  ok "Traefik LoadBalancer EXTERNAL-IP: ${TRAEFIK_LB}"
else
  warn "Traefik EXTERNAL-IP not assigned yet (MetalLB/svclb may still be settling)"
fi

# ---------------------------------------------------------------------------
# 6. Print Forge Settings values
# ---------------------------------------------------------------------------
section "Forge Settings — paste into Admin → Settings → Kubernetes"

echo
echo -e "${C_BOLD}K3S_API_URL${C_RST}"
echo "  ${API_URL}"
echo
echo -e "${C_BOLD}K3S_API_TOKEN${C_RST}"
echo "  ${TOKEN}"
echo
echo -e "${C_BOLD}K3S_VERIFY_TLS${C_RST}"
echo "  false    ${C_DIM}# lab self-signed API cert; set true if you use a trusted cert${C_RST}"
echo
echo -e "${C_DIM}ServiceAccount: default/${USERNAME}${C_RST}"
echo -e "${C_DIM}Secret:         default/${SECRET_NAME}${C_RST}"
if [[ -n "${TRAEFIK_LB}" ]]; then
  echo
  echo -e "${C_BOLD}Ingress DNS tip${C_RST}"
  echo "  Point app hostnames (e.g. www.testlab.int) at Traefik: ${TRAEFIK_LB}"
  echo "  Then open http://<hostname>/ (entrypoint web = port 80)."
fi

echo
echo -e "${C_OK}${C_BOLD}Done.${C_RST} K3s is ready for Forge."
echo
