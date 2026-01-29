"""Flowa Literature Assessment DAG.

Orchestrates variant literature assessment:
1. Query LitVar/Mastermind for PMIDs (or use cached results)
2. For each paper (parallel): download PDF, convert via Docling, extract evidence via LLM
3. Aggregate evidence across all papers
4. Annotate PDFs with highlights
5. Send callback notification

Storage: S3-compatible object storage (MinIO/S3/GCS) via fsspec.
Workers: DockerOperator spawns flowa-worker containers.

Trigger via UI or REST API with params:
    - variant_id: Unique variant identifier
    - gene: Gene symbol (e.g., GAA)
    - hgvs_c: HGVS c. notation (e.g., NM_000152.5:c.2238G>C)
    - callback_url: Optional webhook URL for completion notification
"""

import json
import logging
from datetime import datetime, timedelta

import httpx
from airflow import DAG
from airflow.decorators import task
from airflow.models import Variable
from airflow.models.param import Param
from airflow.operators.python import get_current_context
from airflow.utils.trigger_rule import TriggerRule
from flowa_operator import flowa_task, flowa_task_partial

default_args = {
    'owner': 'flowa',
    'depends_on_past': False,
    'email_on_failure': False,
    'email_on_retry': False,
    'retries': 2,
    'retry_delay': timedelta(seconds=5),
    'execution_timeout': timedelta(minutes=10),
}


def _optional_env(name: str) -> dict[str, str]:
    """Include env var only if the Airflow Variable is set and non-empty.

    Parse-time Variable access is required for dynamically mapped tasks (.expand())
    because Jinja templates inside XCom-backed mapped values don't get rendered.
    """
    try:
        value = Variable.get(name)
        if value:
            return {name: value}
    except KeyError:
        pass
    return {}


# Worker environment variables resolved at parse time.
# Parse-time resolution is required for dynamically mapped tasks (.expand())
# because Jinja templates inside XCom-backed mapped values don't get rendered.
WORKER_ENV = {
    # Required (fail at parse time if missing)
    'FLOWA_STORAGE_BASE': Variable.get('FLOWA_STORAGE_BASE'),
    'FLOWA_MODEL': Variable.get('FLOWA_MODEL'),
    'FLOWA_PROMPT_SET': Variable.get('FLOWA_PROMPT_SET', default_var='generic'),
    # Optional (omitted if not set)
    **_optional_env('FSSPEC_S3_ENDPOINT_URL'),
    **_optional_env('FSSPEC_S3_KEY'),
    **_optional_env('FSSPEC_S3_SECRET'),
    **_optional_env('AWS_ACCESS_KEY_ID'),
    **_optional_env('AWS_SECRET_ACCESS_KEY'),
    **_optional_env('AWS_DEFAULT_REGION'),
    **_optional_env('GOOGLE_APPLICATION_CREDENTIALS'),
    **_optional_env('OPENAI_API_KEY'),
    **_optional_env('OPENAI_BASE_URL'),
    **_optional_env('GOOGLE_API_KEY'),
    **_optional_env('MASTERMIND_API_TOKEN'),
    **_optional_env('NCBI_API_KEY'),
}


with DAG(
    dag_id='flowa_assessment',
    default_args=default_args,
    description='Variant literature assessment with AI extraction',
    schedule=None,
    start_date=datetime(2025, 1, 1),  # manually triggered
    catchup=False,
    max_active_tasks=50,
    render_template_as_native_obj=True,
    params={
        'variant_id': Param(type='string', description='Unique variant identifier'),
        'gene': Param(type='string', description='Gene symbol (e.g., GAA)'),
        'hgvs_c': Param(type='string', description='HGVS c. notation (e.g., NM_000152.5:c.2238G>C)'),
        'callback_url': Param(
            type=['string', 'null'], default=None, description='Optional webhook URL for completion notification'
        ),
    },
) as dag:
    # =========================================================================
    # Pure Python tasks (@task) - lightweight operations, no container overhead
    # =========================================================================

    @task
    def build_process_commands(query_output: str, variant_id: str) -> list[str]:
        """Parse PMIDs from query output and build per-paper processing commands."""
        pmids = json.loads(query_output)
        return [
            f"bash -c 'flowa download --pmid {p} && "
            f'flowa convert --pmid {p} && '
            f'flowa extract --variant-id "{variant_id}" --pmid {p}\''
            for p in pmids
        ]

    @task(trigger_rule=TriggerRule.ALL_DONE)
    def send_callback() -> None:
        """Send completion callback if URL was provided.

        Runs regardless of upstream task status (ALL_DONE trigger rule).
        Simple notification only - caller queries Airflow API for detailed stats.
        """
        context = get_current_context()
        params = context['params']
        callback_url = params.get('callback_url')
        if not callback_url:
            logging.info('No callback URL provided, skipping')
            return

        payload = {
            'variant_id': params['variant_id'],
            'dag_run_id': context['dag_run'].run_id,
        }

        try:
            response = httpx.post(callback_url, json=payload, timeout=30.0)
            response.raise_for_status()
            logging.info(f'Callback sent: {response.status_code}')
        except httpx.HTTPError as e:
            logging.error(f'Callback failed: {e}')
            # Don't raise - callback failure shouldn't fail the DAG

    # =========================================================================
    # Worker tasks - Flowa CLI commands in containers
    # =========================================================================

    query_task = flowa_task(
        'query_literature',
        "flowa query --variant-id '{{ params.variant_id }}' "
        "--gene '{{ params.gene }}' "
        "--hgvs-c '{{ params.hgvs_c }}' "
        "--source '{{ var.value.FLOWA_QUERY_SOURCE }}'",
        WORKER_ENV,
        do_xcom_push=True,  # Capture stdout as XCom (JSON array of PMIDs)
    )

    process_commands = build_process_commands(query_task.output, '{{ params.variant_id }}')

    # --- Per-paper processing ---
    # Download, convert, and extract run sequentially per paper in a single container.
    # This avoids Docker startup overhead for each step while running papers in parallel.
    process_tasks = flowa_task_partial(
        'process_paper',
        WORKER_ENV,
        resource_profile='heavy',
    ).expand(command=process_commands)

    aggregate_task = flowa_task(
        'aggregate_results',
        "flowa aggregate --variant-id '{{ params.variant_id }}'",
        WORKER_ENV,
        trigger_rule=TriggerRule.ALL_DONE,
    )

    annotate_task = flowa_task(
        'annotate_pdfs',
        "flowa annotate --variant-id '{{ params.variant_id }}'",
        WORKER_ENV,
    )

    callback_task = send_callback()

    # =========================================================================
    # Task dependencies
    # =========================================================================
    # query -> build_process_commands -> process_paper[] -> aggregate_results (ALL_DONE)
    #                                                               |
    #                                                      annotate_pdfs -> send_callback (ALL_DONE)

    query_task >> process_commands >> process_tasks >> aggregate_task
    aggregate_task >> annotate_task >> callback_task
