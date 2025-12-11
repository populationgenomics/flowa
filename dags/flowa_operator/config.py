"""Configuration loading and validation for flowa_operator abstraction.

Platform-specific configuration is stored as JSON in Airflow Variables and
validated into dataclasses at DAG parse time for early error detection.
"""

import json
from dataclasses import dataclass, field
from typing import Any, Literal

from airflow.models import Variable

Platform = Literal['docker', 'ecs', 'kubernetes']


@dataclass
class ResourceProfile:
    """Resource requirements for a task.

    cpu: CPU units (e.g., "0.5", "1", "2")
    memory: Memory with unit (e.g., "1Gi", "2Gi", "4Gi")
    """

    cpu: str = '0.5'
    memory: str = '1Gi'


@dataclass
class DockerConfig:
    """Docker-specific configuration."""

    docker_url: str = 'unix://var/run/docker.sock'
    network_mode: str = 'bridge'
    auto_remove: str = 'success'
    mount_tmp_dir: bool = False


@dataclass
class EcsConfig:
    """ECS Fargate configuration.

    A single Task Definition is used; CPU/memory are applied as runtime overrides.
    """

    cluster: str
    task_definition: str
    network_configuration: dict[str, Any] = field(default_factory=dict)
    awslogs_group: str | None = None
    awslogs_region: str | None = None
    awslogs_stream_prefix: str | None = None
    aws_conn_id: str = 'aws_default'


@dataclass
class KubernetesConfig:
    """Kubernetes/Cloud Composer configuration."""

    namespace: str = 'default'
    in_cluster: bool = True
    get_logs: bool = True
    is_delete_operator_pod: bool = True
    startup_timeout_seconds: int = 300
    image_pull_policy: str = 'Always'
    service_account_name: str | None = None
    config_file: str | None = None  # For out-of-cluster access


def _parse_json_variable(name: str, default: str = '{}') -> dict[str, Any]:
    """Parse a JSON Airflow Variable, returning default if not set."""
    raw = Variable.get(name, default_var=default)
    return json.loads(raw) if isinstance(raw, str) else raw


def get_platform() -> Platform:
    """Get the configured platform.

    Raises if FLOWA_PLATFORM is not set.
    """
    try:
        platform = Variable.get('FLOWA_PLATFORM')
    except KeyError as e:
        raise ValueError(
            'FLOWA_PLATFORM Airflow Variable is required. Set it to one of: docker, ecs, kubernetes'
        ) from e
    if platform not in ('docker', 'ecs', 'kubernetes'):
        raise ValueError(f"Invalid FLOWA_PLATFORM: '{platform}'. Must be one of: docker, ecs, kubernetes")
    return platform  # type: ignore[return-value]


def get_worker_image() -> str:
    """Get the worker container image."""
    return Variable.get('FLOWA_WORKER_IMAGE', default_var='flowa-worker:latest')


def get_resource_profiles() -> dict[str, ResourceProfile]:
    """Load resource profiles from Variable.

    Returns empty dict if not configured (profiles are optional).
    """
    profiles_dict = _parse_json_variable('FLOWA_RESOURCE_PROFILES')
    return {name: ResourceProfile(**cfg) for name, cfg in profiles_dict.items()}


def get_docker_config() -> DockerConfig:
    """Load Docker configuration."""
    cfg = _parse_json_variable('FLOWA_DOCKER_CONFIG')
    return DockerConfig(**cfg)


def get_ecs_config() -> EcsConfig:
    """Load ECS configuration.

    Raises if FLOWA_ECS_CONFIG is not set (required for ECS platform).
    """
    try:
        raw = Variable.get('FLOWA_ECS_CONFIG')
    except KeyError as e:
        raise ValueError(
            'FLOWA_ECS_CONFIG Airflow Variable is required when FLOWA_PLATFORM=ecs. '
            'Set it to a JSON object with cluster, task_definition, and '
            'network_configuration.'
        ) from e
    cfg = json.loads(raw) if isinstance(raw, str) else raw
    return EcsConfig(**cfg)


def get_kubernetes_config() -> KubernetesConfig:
    """Load Kubernetes configuration."""
    cfg = _parse_json_variable('FLOWA_K8S_CONFIG')
    return KubernetesConfig(**cfg)
