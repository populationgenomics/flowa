"""Portable task factory for Flowa DAG.

Automatically selects the appropriate operator based on FLOWA_PLATFORM:
- docker: DockerOperator (local development)
- ecs: EcsRunTaskOperator (AWS MWAA / Fargate)
- kubernetes: KubernetesPodOperator (GKE / Cloud Composer)

Usage:
    from flowa_operator import flowa_task, flowa_task_partial

    task = flowa_task('my_task', 'flowa command...', WORKER_ENV)
    tasks = flowa_task_partial('process_paper', WORKER_ENV).expand(command=commands)
"""

from typing import Any

from airflow.models import BaseOperator

from .config import (
    get_docker_config,
    get_ecs_config,
    get_kubernetes_config,
    get_platform,
    get_resource_profiles,
    get_worker_image,
)


def flowa_task(
    task_id: str,
    command: str,
    worker_env: dict[str, str],
    resource_profile: str = 'default',
    **kwargs: Any,
) -> BaseOperator:
    """Create a platform-appropriate task for running a Flowa CLI command.

    Args:
        task_id: Airflow task ID
        command: Shell command to run in the worker container
        worker_env: Environment variables for the worker container
        resource_profile: Name of resource profile (from FLOWA_RESOURCE_PROFILES)
        **kwargs: Additional operator-specific arguments

    Returns:
        Appropriate operator for the configured platform
    """
    platform = get_platform()
    image = get_worker_image()
    profiles = get_resource_profiles()
    profile = profiles.get(resource_profile)

    if platform == 'docker':
        from .docker import build_docker_task

        return build_docker_task(
            task_id=task_id,
            command=command,
            image=image,
            environment=worker_env,
            config=get_docker_config(),
            resource_profile=profile,
            **kwargs,
        )

    elif platform == 'ecs':
        from .ecs import build_ecs_task

        return build_ecs_task(
            task_id=task_id,
            command=command,
            image=image,
            environment=worker_env,
            config=get_ecs_config(),
            resource_profile=profile,
            **kwargs,
        )

    elif platform == 'kubernetes':
        from .kubernetes import build_kubernetes_task

        return build_kubernetes_task(
            task_id=task_id,
            command=command,
            image=image,
            environment=worker_env,
            config=get_kubernetes_config(),
            resource_profile=profile,
            **kwargs,
        )

    else:
        raise ValueError(f'Unknown platform: {platform}')


class _PartialTaskBuilder:
    """Builder for creating partial tasks for dynamic mapping with .expand()."""

    def __init__(
        self,
        task_id: str,
        worker_env: dict[str, str],
        resource_profile: str = 'default',
        **kwargs: Any,
    ) -> None:
        self.task_id = task_id
        self.worker_env = worker_env
        self.resource_profile = resource_profile
        self.kwargs = kwargs

    def expand(self, command: Any) -> Any:
        """Expand over commands, returning appropriate operator.partial().expand()."""
        platform = get_platform()
        image = get_worker_image()
        profiles = get_resource_profiles()
        profile = profiles.get(self.resource_profile)

        if platform == 'docker':
            from airflow.providers.docker.operators.docker import DockerOperator

            from .docker import get_docker_partial_kwargs

            partial_kwargs = get_docker_partial_kwargs(
                image=image,
                environment=self.worker_env,
                config=get_docker_config(),
                resource_profile=profile,
            )
            partial_kwargs.update(self.kwargs)
            return DockerOperator.partial(
                task_id=self.task_id,
                **partial_kwargs,
            ).expand(command=command)

        elif platform == 'ecs':
            from airflow.providers.amazon.aws.operators.ecs import EcsRunTaskOperator

            from .ecs import build_ecs_overrides_for_command, get_ecs_partial_kwargs

            partial_kwargs = get_ecs_partial_kwargs(
                image=image,
                environment=self.worker_env,
                config=get_ecs_config(),
                resource_profile=profile,
            )
            env = partial_kwargs.pop('_flowa_env')
            res_profile = partial_kwargs.pop('_flowa_resource_profile')
            partial_kwargs.update(self.kwargs)

            # Transform commands to overrides
            overrides = command.map(lambda cmd: build_ecs_overrides_for_command(cmd, env, res_profile))
            return EcsRunTaskOperator.partial(
                task_id=self.task_id,
                **partial_kwargs,
            ).expand(overrides=overrides)

        elif platform == 'kubernetes':
            from airflow.providers.cncf.kubernetes.operators.kubernetes_pod import (
                KubernetesPodOperator,
            )

            from .kubernetes import get_kubernetes_partial_kwargs

            partial_kwargs = get_kubernetes_partial_kwargs(
                image=image,
                environment=self.worker_env,
                config=get_kubernetes_config(),
                resource_profile=profile,
            )
            partial_kwargs.update(self.kwargs)

            # K8s uses 'arguments' for the command
            arguments = command.map(lambda cmd: [cmd])
            pod_name = self.task_id.replace('_', '-').lower()

            return KubernetesPodOperator.partial(
                task_id=self.task_id,
                name=pod_name,
                **partial_kwargs,
            ).expand(arguments=arguments)

        else:
            raise ValueError(f'Unknown platform: {platform}')


def flowa_task_partial(
    task_id: str,
    worker_env: dict[str, str],
    resource_profile: str = 'default',
    **kwargs: Any,
) -> _PartialTaskBuilder:
    """Create a partial task builder for dynamic mapping with .expand().

    Usage:
        commands = build_commands_task.output
        tasks = flowa_task_partial('process_paper', WORKER_ENV).expand(command=commands)

    Args:
        task_id: Airflow task ID
        worker_env: Environment variables for the worker container
        resource_profile: Name of resource profile
        **kwargs: Additional operator-specific arguments

    Returns:
        A builder object with an .expand(command=...) method
    """
    return _PartialTaskBuilder(task_id, worker_env, resource_profile, **kwargs)


__all__ = [
    'flowa_task',
    'flowa_task_partial',
]
