"""HTTP shape tests for /health, /runs, /runs/active.

These don't exercise the runner — that's `test_runs.py`. They check the
request validation, response shape, status codes, and FastAPI plumbing.
"""

from fastapi.testclient import TestClient


def test_health_returns_ok(client: TestClient) -> None:
    response = client.get('/health')
    assert response.status_code == 200
    assert response.json() == {'status': 'ok'}


def test_post_runs_returns_record(client: TestClient) -> None:
    response = client.post(
        '/runs',
        json={
            'variant_id': 'F508del',
            'variant_spec': {
                'schema_version': 1,
                'variants': [{'kind': 'hgvs_c', 'transcript': 'NM_000492.4', 'hgvs_c': 'c.1521_1523del'}],
            },
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body['variant_id'] == 'F508del'
    assert body['status'] == 'running'
    assert body['run_id']
    assert body['started_at']


def test_post_runs_rejects_malformed_body(client: TestClient) -> None:
    # missing variant_id + variant_spec → 422
    response = client.post('/runs', json={'variant_id': 'X'})
    assert response.status_code == 422


def test_get_runs_active_returns_404_when_no_run(client: TestClient) -> None:
    response = client.get('/runs/active', params={'variant_id': 'unknown'})
    assert response.status_code == 404


def test_get_runs_active_returns_record_after_post(client: TestClient) -> None:
    client.post('/runs', json={
            'variant_id': 'X',
            'variant_spec': {
                'schema_version': 1,
                'variants': [{'kind': 'hgvs_c', 'transcript': 'NM_000001.1', 'hgvs_c': 'c.1A>T'}],
            },
        })
    response = client.get('/runs/active', params={'variant_id': 'X'})
    assert response.status_code == 200
    assert response.json()['variant_id'] == 'X'


def test_post_runs_returns_409_when_in_flight(client: TestClient, app) -> None:
    """Replace the manager's pipeline with one that hangs so the first run
    stays in `running` state across the second POST."""
    import asyncio

    from demo_gateway.runs import RunManager

    from .conftest import make_flowa_settings

    never_returns = asyncio.Event()

    async def hangs(*_args: object, **_kwargs: object) -> None:
        await never_returns.wait()

    app.state.runs = RunManager(
        flowa_settings=make_flowa_settings(app.state.settings.demo_data_dir),
        data_dir=app.state.settings.demo_data_dir,
        max_concurrent_runs=app.state.settings.demo_max_concurrent_runs,
        pipeline=hangs,
    )

    first = client.post('/runs', json={
            'variant_id': 'V',
            'variant_spec': {
                'schema_version': 1,
                'variants': [{'kind': 'hgvs_c', 'transcript': 'NM_000001.1', 'hgvs_c': 'c.1A>T'}],
            },
        })
    assert first.status_code == 200

    second = client.post('/runs', json={
            'variant_id': 'V',
            'variant_spec': {
                'schema_version': 1,
                'variants': [{'kind': 'hgvs_c', 'transcript': 'NM_000001.1', 'hgvs_c': 'c.1A>T'}],
            },
        })
    assert second.status_code == 409
