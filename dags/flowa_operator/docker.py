"""DockerOperator builder for local development."""

from typing import Any

from airflow.providers.docker.operators.docker import DockerOperator

from .config import DockerConfig, ResourceProfile


def build_docker_task(
    task_id: str,
    command: str,
    image: str,
    environment: dict[str, str],
    config: DockerConfig,
    resource_profile: ResourceProfile | None = None,
    **kwargs: Any,
) -> DockerOperator:
    """Build a DockerOperator task.

    Args:
        task_id: Airflow task ID
        command: Shell command to run
        image: Container image
        environment: Environment variables
        config: Docker-specific configuration
        resource_profile: Optional resource limits (usually not enforced locally)
        **kwargs: Additional DockerOperator arguments

    Returns:
        Configured DockerOperator
    """
    operator_kwargs: dict[str, Any] = {
        'task_id': task_id,
        'command': command,
        'image': image,
        'environment': environment,
        'docker_url': config.docker_url,
        'network_mode': config.network_mode,
        'auto_remove': config.auto_remove,
        'mount_tmp_dir': config.mount_tmp_dir,
    }

    # Optionally apply resource limits (usually not needed for local dev)
    if resource_profile:
        operator_kwargs['mem_limit'] = resource_profile.memory
        # Docker cpu_quota is in microseconds per 100ms period
        # cpu=0.5 means 50000 microseconds per period
        try:
            cpu_float = float(resource_profile.cpu)
        except ValueError as e:
            raise ValueError(f"Invalid CPU value '{resource_profile.cpu}': must be a number (e.g., '0.5', '1')") from e
        operator_kwargs['cpu_quota'] = int(cpu_float * 100000)

    operator_kwargs.update(kwargs)
    return DockerOperator(**operator_kwargs)


def get_docker_partial_kwargs(
    image: str,
    environment: dict[str, str],
    config: DockerConfig,
    resource_profile: ResourceProfile | None = None,
) -> dict[str, Any]:
    """Get kwargs for DockerOperator.partial() for dynamic task mapping.

    Args:
        image: Container image
        environment: Environment variables
        config: Docker-specific configuration
        resource_profile: Optional resource limits

    Returns:
        Dict of kwargs to pass to DockerOperator.partial()
    """
    kwargs: dict[str, Any] = {
        'image': image,
        'environment': environment,
        'docker_url': config.docker_url,
        'network_mode': config.network_mode,
        'auto_remove': config.auto_remove,
        'mount_tmp_dir': config.mount_tmp_dir,
    }

    if resource_profile:
        kwargs['mem_limit'] = resource_profile.memory
        try:
            cpu_float = float(resource_profile.cpu)
        except ValueError as e:
            raise ValueError(f"Invalid CPU value '{resource_profile.cpu}': must be a number (e.g., '0.5', '1')") from e
        kwargs['cpu_quota'] = int(cpu_float * 100000)

    return kwargs
