"""KubernetesPodOperator builder for GKE / Cloud Composer deployments."""

from typing import Any

from airflow.providers.cncf.kubernetes.operators.kubernetes_pod import (
    KubernetesPodOperator,
)
from kubernetes.client import models as k8s_models

from .config import KubernetesConfig, ResourceProfile


def _parse_cpu(cpu: str) -> str:
    """Convert CPU string to Kubernetes format (millicores).

    Examples:
        "0.5" -> "500m"
        "1" -> "1000m"
        "2" -> "2000m"
        "500m" -> "500m" (passthrough)

    Raises:
        ValueError: If cpu cannot be parsed
    """
    cpu = cpu.strip()
    if cpu.endswith('m'):
        return cpu  # Already in millicores

    try:
        return f'{int(float(cpu) * 1000)}m'
    except ValueError as e:
        raise ValueError(
            f"Invalid CPU value '{cpu}': must be a number (e.g., '0.5', '1') or millicores (e.g., '500m')"
        ) from e


def _parse_memory(memory: str) -> str:
    """Validate and normalize memory string for Kubernetes.

    Kubernetes accepts: Gi, Mi, Ki, G, M, K (and raw bytes)
    We pass through valid formats; raise on invalid.

    Raises:
        ValueError: If memory format is not recognized
    """
    memory = memory.strip()
    valid_suffixes = ('Gi', 'Mi', 'Ki', 'G', 'M', 'K')

    for suffix in valid_suffixes:
        if memory.endswith(suffix):
            # Validate the numeric part
            numeric = memory[: -len(suffix)]
            try:
                float(numeric)
                return memory
            except ValueError as e:
                raise ValueError(f"Invalid memory value '{memory}': numeric part '{numeric}' is not a number") from e

    raise ValueError(f"Invalid memory format '{memory}': must end with one of {valid_suffixes} (e.g., '1Gi', '512Mi')")


def _build_env_vars(environment: dict[str, str]) -> list[k8s_models.V1EnvVar]:
    """Convert environment dict to Kubernetes V1EnvVar list."""
    return [k8s_models.V1EnvVar(name=k, value=v) for k, v in environment.items()]


def _build_resources(
    resource_profile: ResourceProfile | None,
) -> k8s_models.V1ResourceRequirements | None:
    """Build Kubernetes resource requirements from profile."""
    if not resource_profile:
        return None

    cpu = _parse_cpu(resource_profile.cpu)
    memory = _parse_memory(resource_profile.memory)

    return k8s_models.V1ResourceRequirements(
        requests={'cpu': cpu, 'memory': memory},
        limits={'cpu': cpu, 'memory': memory},
    )


def build_kubernetes_task(
    task_id: str,
    command: str,
    image: str,
    environment: dict[str, str],
    config: KubernetesConfig,
    resource_profile: ResourceProfile | None = None,
    **kwargs: Any,
) -> KubernetesPodOperator:
    """Build a KubernetesPodOperator task.

    Args:
        task_id: Airflow task ID
        command: Shell command to run
        image: Container image
        environment: Environment variables
        config: Kubernetes-specific configuration
        resource_profile: Optional resource limits
        **kwargs: Additional KubernetesPodOperator arguments

    Returns:
        Configured KubernetesPodOperator
    """
    # K8s names must be lowercase, alphanumeric, and can contain hyphens
    pod_name = task_id.replace('_', '-').lower()

    operator_kwargs: dict[str, Any] = {
        'task_id': task_id,
        'name': pod_name,
        'namespace': config.namespace,
        'image': image,
        'cmds': ['sh', '-c'],
        'arguments': [command],
        'env_vars': _build_env_vars(environment),
        'in_cluster': config.in_cluster,
        'get_logs': config.get_logs,
        'is_delete_operator_pod': config.is_delete_operator_pod,
        'startup_timeout_seconds': config.startup_timeout_seconds,
        'image_pull_policy': config.image_pull_policy,
    }

    # Resource requirements
    resources = _build_resources(resource_profile)
    if resources:
        operator_kwargs['container_resources'] = resources

    # Optional service account
    if config.service_account_name:
        operator_kwargs['service_account_name'] = config.service_account_name

    # Out-of-cluster config file (for local testing against remote cluster)
    if config.config_file:
        operator_kwargs['config_file'] = config.config_file

    operator_kwargs.update(kwargs)
    return KubernetesPodOperator(**operator_kwargs)


def get_kubernetes_partial_kwargs(
    image: str,
    environment: dict[str, str],
    config: KubernetesConfig,
    resource_profile: ResourceProfile | None = None,
) -> dict[str, Any]:
    """Get kwargs for KubernetesPodOperator.partial() for dynamic task mapping.

    Args:
        image: Container image
        environment: Environment variables
        config: Kubernetes-specific configuration
        resource_profile: Optional resource limits

    Returns:
        Dict of kwargs to pass to KubernetesPodOperator.partial()
    """
    kwargs: dict[str, Any] = {
        'namespace': config.namespace,
        'image': image,
        'cmds': ['sh', '-c'],
        'env_vars': _build_env_vars(environment),
        'in_cluster': config.in_cluster,
        'get_logs': config.get_logs,
        'is_delete_operator_pod': config.is_delete_operator_pod,
        'startup_timeout_seconds': config.startup_timeout_seconds,
        'image_pull_policy': config.image_pull_policy,
    }

    resources = _build_resources(resource_profile)
    if resources:
        kwargs['container_resources'] = resources

    if config.service_account_name:
        kwargs['service_account_name'] = config.service_account_name

    if config.config_file:
        kwargs['config_file'] = config.config_file

    return kwargs
