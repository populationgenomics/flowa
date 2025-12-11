"""EcsRunTaskOperator builder for AWS MWAA / Fargate deployments."""

from typing import Any

from airflow.providers.amazon.aws.operators.ecs import EcsRunTaskOperator

from .config import EcsConfig, ResourceProfile

# Container name in the ECS Task Definition - must match
CONTAINER_NAME = 'flowa-worker'


def _cpu_to_fargate_units(cpu: str) -> str:
    """Convert CPU string to Fargate units (1 vCPU = 1024).

    Examples:
        "0.25" -> "256"
        "0.5" -> "512"
        "1" -> "1024"
        "2" -> "2048"

    Raises:
        ValueError: If cpu cannot be parsed as a number
    """
    try:
        return str(int(float(cpu) * 1024))
    except ValueError as e:
        raise ValueError(f"Invalid CPU value '{cpu}': must be a number (e.g., '0.5', '1', '2')") from e


def _memory_to_fargate_units(memory: str) -> str:
    """Convert memory string to Fargate units (MB).

    Examples:
        "1Gi" -> "1024"
        "2Gi" -> "2048"
        "512Mi" -> "512"

    Raises:
        ValueError: If memory format is not recognized
    """
    memory = memory.strip()
    try:
        if memory.endswith('Gi'):
            return str(int(float(memory[:-2]) * 1024))
        elif memory.endswith('Mi'):
            return str(int(float(memory[:-2])))
        elif memory.endswith('G'):
            return str(int(float(memory[:-1]) * 1024))
        elif memory.endswith('M'):
            return str(int(float(memory[:-1])))
        else:
            raise ValueError(
                f"Invalid memory format '{memory}': must end with Gi, Mi, G, or M (e.g., '1Gi', '512Mi', '2G')"
            )
    except ValueError:
        raise


def _build_overrides(
    command: str,
    environment: dict[str, str],
    resource_profile: ResourceProfile | None,
) -> dict[str, Any]:
    """Build ECS task overrides for command, environment, and resources."""
    container_override: dict[str, Any] = {
        'name': CONTAINER_NAME,
        'command': ['sh', '-c', command],
        'environment': [{'name': k, 'value': v} for k, v in environment.items()],
    }

    overrides: dict[str, Any] = {'containerOverrides': [container_override]}

    # Apply CPU/memory as task-level overrides (Fargate)
    if resource_profile:
        overrides['cpu'] = _cpu_to_fargate_units(resource_profile.cpu)
        overrides['memory'] = _memory_to_fargate_units(resource_profile.memory)

    return overrides


def build_ecs_task(
    task_id: str,
    command: str,
    image: str,
    environment: dict[str, str],
    config: EcsConfig,
    resource_profile: ResourceProfile | None = None,
    **kwargs: Any,
) -> EcsRunTaskOperator:
    """Build an EcsRunTaskOperator task.

    Args:
        task_id: Airflow task ID
        command: Shell command to run
        image: Container image (ignored - comes from Task Definition)
        environment: Environment variables
        config: ECS-specific configuration
        resource_profile: Optional resource limits (applied as overrides)
        **kwargs: Additional EcsRunTaskOperator arguments

    Returns:
        Configured EcsRunTaskOperator
    """
    operator_kwargs: dict[str, Any] = {
        'task_id': task_id,
        'cluster': config.cluster,
        'task_definition': config.task_definition,
        'launch_type': 'FARGATE',
        'overrides': _build_overrides(command, environment, resource_profile),
        'aws_conn_id': config.aws_conn_id,
        'wait_for_completion': True,
        'reattach': True,  # Resume if Airflow connection drops
    }

    # Network configuration (required for Fargate)
    if config.network_configuration:
        operator_kwargs['network_configuration'] = config.network_configuration

    # CloudWatch logs configuration
    if config.awslogs_group:
        operator_kwargs['awslogs_group'] = config.awslogs_group
        operator_kwargs['awslogs_region'] = config.awslogs_region
        operator_kwargs['awslogs_stream_prefix'] = config.awslogs_stream_prefix

    operator_kwargs.update(kwargs)
    return EcsRunTaskOperator(**operator_kwargs)


def get_ecs_partial_kwargs(
    image: str,
    environment: dict[str, str],
    config: EcsConfig,
    resource_profile: ResourceProfile | None = None,
) -> dict[str, Any]:
    """Get kwargs for EcsRunTaskOperator.partial() for dynamic task mapping.

    Note: For ECS, the command is passed via 'overrides' not 'command'.
    This means we need to expand on 'overrides' with pre-built override dicts,
    or use a wrapper approach. This returns the base kwargs without command.

    Args:
        image: Container image (ignored - comes from Task Definition)
        environment: Environment variables
        config: ECS-specific configuration
        resource_profile: Optional resource limits

    Returns:
        Dict of kwargs to pass to EcsRunTaskOperator.partial()
    """
    kwargs: dict[str, Any] = {
        'cluster': config.cluster,
        'task_definition': config.task_definition,
        'launch_type': 'FARGATE',
        'aws_conn_id': config.aws_conn_id,
        'wait_for_completion': True,
        'reattach': True,
    }

    if config.network_configuration:
        kwargs['network_configuration'] = config.network_configuration

    if config.awslogs_group:
        kwargs['awslogs_group'] = config.awslogs_group
        kwargs['awslogs_region'] = config.awslogs_region
        kwargs['awslogs_stream_prefix'] = config.awslogs_stream_prefix

    # Store these for building overrides during expand
    kwargs['_flowa_env'] = environment
    kwargs['_flowa_resource_profile'] = resource_profile

    return kwargs


def build_ecs_overrides_for_command(
    command: str,
    environment: dict[str, str],
    resource_profile: ResourceProfile | None,
) -> dict[str, Any]:
    """Build ECS overrides dict for a single command.

    Use this with dynamic task mapping to transform commands into overrides.
    """
    return _build_overrides(command, environment, resource_profile)
