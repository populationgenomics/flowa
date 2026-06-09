"""Variant normaliser over Ensembl REST (VEP + Variant Recoder).

VEP supplies the annotation (gene, MANE Select, transcripts, protein,
exon/intron, rsID); the `grch38` genomic block comes from the Ensembl
Variant Recoder, which returns canonical forward-strand `hgvsg`/`spdi` for
SNVs, indels, and splice variants alike. (VEP's HGVS-c endpoint returns no
`hgvsg`, and its `allele_string` is in the overlapped transcript's strand —
the minus strand for reverse-strand genes — so a forward-strand genomic
HGVS can't be derived from it.) Both endpoints share `rest.ensembl.org`.

Produces the canonical normalised-variant dict consumed by:

- the LLM prompt — `extract.py` and `aggregate.py` `json.dumps` this dict
  into the `{{ variant_details }}` placeholder,
- the Mastermind query (pulls `grch38` for the NC_:g. form),
- the LitVar query (pulls `rsid` for the autocomplete path; falls back to
  `gene_symbol` + protein short form when no rsid),
- ClinVar lookup (uses the colon-glued HGVS reconstructed from the
  caller's `variant_spec`).

The output is a plain `dict`; no Pydantic model exists for the normalised
shape because every consumer just reads fields. A missing field surfaces
as a `KeyError` / `TypeError` just as loudly as a `ValidationError`, and
the shape doesn't cross a trust boundary that warrants a schema layer.

Returned dict shape (`schema_version=1`)::

    {
      "schema_version": 1,
      "source": "vep",
      "source_version": "<release>" | None,    # X-Ensembl-Release header when present
      "fetched_at": "2026-...Z",                # ISO 8601 UTC

      "gene_symbol": "RYR2",                    # VEP authoritative
      "hgnc_id": "HGNC:10484" | None,
      "rsid": "rs2149437479" | None,            # colocated_variants[].id when present

      "grch38": {
        "hgvs_g": "NC_000001.11:g.237806159A>G",
        "chrom": "1", "pos": 237806159, "ref": "A", "alt": "G"
      },
      "grch37": { ... } | None,                 # liftover (not currently fetched)

      "mane_select": { ...full projection... } | None,
      "user_transcript": { ...full projection... } | None,
      "alternate_transcripts": [ ...compact projections... ]
    }

A full transcript projection (`mane_select`, `user_transcript`)::

    {
      "transcript_id": "NM_001035.3",
      "hgvs_c": "NM_001035.3:c.14174A>G",
      "protein_short": "NP_001026.2:p.Y4725C" | None,
      "protein_long":  "NP_001026.2:p.Tyr4725Cys" | None,
      "exon": "99/105" | None,
      "intron": "1/19" | None,                  # populated for intronic variants
      "consequence_terms": ["missense_variant"]
    }

A compact projection (each entry in `alternate_transcripts`)::

    { "transcript_id": "NM_001035.2", "hgvs_c": "NM_001035.2:c.14174A>G" }

VEP REST's standard endpoint is called with `refseq=1`, which swaps the
Ensembl transcript set for RefSeq throughout — transcript and protein
identifiers arrive as RefSeq NM_ / NP_ directly (`hgvsc` / `hgvsp` carry
the RefSeq-prefixed form), so no ENST→NM_ / ENSP→NP_ rebranding step
is needed. Note that with `refseq=1` the `transcript_consequences[].mane_select`
field flips its semantics: it now carries the *Ensembl* MANE counterpart
of a RefSeq transcript (populated iff this entry is the MANE Select
transcript). We use its truthiness as the MANE marker.

`alternate_transcripts` is filtered to RefSeq NM_ entries with the
`protein_coding` biotype; XM_ predictions, NMD targets, retained-intron
biotypes, and the gene's MANE Select / the caller-supplied transcript
(already rendered as full blocks) are excluded so the LLM prompt carries
clinical-literature-relevant transcripts only.
"""

import asyncio
import logging
import re
from datetime import UTC, datetime

import httpx

from flowa.http_retry import retry_transient_http
from flowa.schema import NORMALIZED_VARIANT_SCHEMA_VERSION

log = logging.getLogger(__name__)

VEP_REST_BASE = 'https://rest.ensembl.org'

# GRCh38 chromosome name → RefSeq accession used in HGVS g. notation.
# Source: NCBI GRCh38.p14 assembly definitions.
_GRCH38_NC: dict[str, str] = {
    '1': 'NC_000001.11',
    '2': 'NC_000002.12',
    '3': 'NC_000003.12',
    '4': 'NC_000004.12',
    '5': 'NC_000005.10',
    '6': 'NC_000006.12',
    '7': 'NC_000007.14',
    '8': 'NC_000008.11',
    '9': 'NC_000009.12',
    '10': 'NC_000010.11',
    '11': 'NC_000011.10',
    '12': 'NC_000012.12',
    '13': 'NC_000013.11',
    '14': 'NC_000014.9',
    '15': 'NC_000015.10',
    '16': 'NC_000016.10',
    '17': 'NC_000017.11',
    '18': 'NC_000018.10',
    '19': 'NC_000019.10',
    '20': 'NC_000020.11',
    '21': 'NC_000021.9',
    '22': 'NC_000022.11',
    'X': 'NC_000023.11',
    'Y': 'NC_000024.10',
    'MT': 'NC_012920.1',
}

# Amino acid 3-letter → 1-letter for HGVS p. short-form derivation.
_AA_3_TO_1: dict[str, str] = {
    'Ala': 'A',
    'Arg': 'R',
    'Asn': 'N',
    'Asp': 'D',
    'Cys': 'C',
    'Glu': 'E',
    'Gln': 'Q',
    'Gly': 'G',
    'His': 'H',
    'Ile': 'I',
    'Leu': 'L',
    'Lys': 'K',
    'Met': 'M',
    'Phe': 'F',
    'Pro': 'P',
    'Ser': 'S',
    'Thr': 'T',
    'Trp': 'W',
    'Tyr': 'Y',
    'Val': 'V',
    'Ter': '*',
    'Sec': 'U',
    'Pyl': 'O',
}

_AA_3_LETTER_RE = re.compile(r'[A-Z][a-z]{2}')

# Biotypes whose transcripts we surface in the LLM prompt. NMD targets,
# retained-intron, processed-transcript, non-coding etc. are dropped at
# normalisation time so the prompt isn't bloated with computational noise.
_PROMPT_RELEVANT_BIOTYPES: frozenset[str] = frozenset({'protein_coding'})


@retry_transient_http
async def _fetch_vep(hgvs: str) -> tuple[list[dict], str | None]:
    """Call VEP REST for a single HGVS string with RefSeq annotation enabled.

    Uses the standard `/vep/human/hgvs/<hgvs>` endpoint with `refseq=1`,
    which swaps Ensembl transcripts for RefSeq (NM_/NP_) throughout the
    response.

    Returns (annotations, ensembl_release_version). Annotations is a list
    of dicts (one per HGVS input; length 1 for our single-input call).
    Release version comes from the X-Ensembl-Release header when present.
    """
    url = f'{VEP_REST_BASE}/vep/human/hgvs/{hgvs}'
    params = {'mane': 1, 'numbers': 1, 'protein': 1, 'hgvs': 1, 'refseq': 1}

    log.info('Querying VEP REST for %s', hgvs)
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(
            url,
            params=params,
            headers={'accept': 'application/json'},
        )
        response.raise_for_status()
        return response.json(), response.headers.get('x-ensembl-release')


@retry_transient_http
async def _fetch_recoder(hgvs: str) -> dict:
    """Resolve canonical forward-strand genomic forms via Ensembl Variant Recoder.

    VEP's `/vep/human/hgvs` endpoint never returns `hgvsg`, and its
    `allele_string` is in the overlapped transcript's strand orientation, so a
    minus-strand coding or splice variant can't be turned into a forward-strand
    genomic HGVS from VEP alone. The Variant Recoder
    (`/variant_recoder/human/<hgvs>`, same Ensembl REST host) maps any input —
    SNV, indel, deep-intronic/splice — to canonical GRCh38 `hgvsg` + `spdi`.

    Returns the single allele record (our inputs carry one alt allele).
    """
    url = f'{VEP_REST_BASE}/variant_recoder/human/{hgvs}'

    log.info('Querying Variant Recoder REST for %s', hgvs)
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(url, headers={'accept': 'application/json'})
        response.raise_for_status()
        data = response.json()

    if not isinstance(data, list) or not data:
        raise ValueError(f'Variant Recoder returned no records for {hgvs!r}')
    # Each list entry maps allele -> record; the single-allele input yields one
    # record carrying hgvsg/spdi. Non-dict housekeeping values (e.g. a warnings
    # list) are skipped.
    for rec in data[0].values():
        if isinstance(rec, dict) and rec.get('hgvsg'):
            return rec
    raise ValueError(f'Variant Recoder record lacked hgvsg for {hgvs!r}')


def _strip_version(transcript_id: str) -> str:
    """`NM_001035.3` → `NM_001035`. Pass-through for empty/None-shaped inputs."""
    if not transcript_id:
        return ''
    return transcript_id.split('.', 1)[0]


def _three_letter_to_one(hgvs_p_long: str | None) -> str | None:
    """`NP_001026.2:p.Tyr4725Cys` → `NP_001026.2:p.Y4725C`.

    Parentheses, `=` (synonymous), `*` / `Ter` (stop), and `fs` / `ext` markers
    are preserved; only 3-letter amino-acid codes are substituted.
    """
    if not hgvs_p_long or ':' not in hgvs_p_long:
        return None
    prefix, change = hgvs_p_long.split(':', 1)

    def repl(match: re.Match[str]) -> str:
        token = match.group(0)
        return _AA_3_TO_1.get(token, token)

    return f'{prefix}:{_AA_3_LETTER_RE.sub(repl, change)}'


def _project_transcript_full(tc: dict) -> dict:
    """Full per-transcript projection (rendered as a block in the prompt)."""
    hgvs_p_long = tc.get('hgvsp')
    return {
        'transcript_id': tc['transcript_id'],
        'hgvs_c': tc.get('hgvsc'),
        'protein_short': _three_letter_to_one(hgvs_p_long),
        'protein_long': hgvs_p_long,
        'exon': tc.get('exon'),
        'intron': tc.get('intron'),
        'consequence_terms': list(tc.get('consequence_terms', [])),
    }


def _project_transcript_compact(tc: dict) -> dict:
    """Compact per-transcript projection (one line in the prompt)."""
    return {
        'transcript_id': tc['transcript_id'],
        'hgvs_c': tc.get('hgvsc'),
    }


def _grch38_from_recoder(rec: dict, hgvs: str) -> dict:
    """Build the `grch38` block from a Variant Recoder allele record.

    Picks the GRCh38 primary-assembly forms by their `NC_` accession (the
    Recoder also returns `LRG_` / `NW_` alternates, which we drop). `hgvs_g` is
    taken verbatim — already the `NC_<chr>.<ver>:g.…` shape Mastermind wants —
    and `chrom`/`pos`/`ref`/`alt` come from the matching SPDI
    (`<acc>:<0-based-pos>:<ref>:<alt>`), correct for SNVs and indels alike.
    """
    nc_to_chrom = {nc: chrom for chrom, nc in _GRCH38_NC.items()}
    hgvs_g = next((h for h in rec.get('hgvsg', []) if h.split(':', 1)[0] in nc_to_chrom), None)
    spdi = next((s for s in rec.get('spdi', []) if s.split(':', 1)[0] in nc_to_chrom), None)
    if hgvs_g is None or spdi is None:
        raise ValueError(
            f'Variant Recoder returned no GRCh38 NC_ genomic form for {hgvs!r} '
            f'(hgvsg={rec.get("hgvsg")}, spdi={rec.get("spdi")})'
        )
    acc, pos0, ref, alt = spdi.split(':')
    return {
        'hgvs_g': hgvs_g,
        'chrom': nc_to_chrom[acc],
        'pos': int(pos0) + 1,  # SPDI is 0-based; grch38.pos is 1-based
        'ref': ref,
        'alt': alt,
    }


def _select_rsid(annotation: dict) -> str | None:
    """Pull the first rsID from `colocated_variants[]`, if any."""
    for cv in annotation.get('colocated_variants', []):
        cv_id = cv.get('id', '')
        if cv_id.startswith('rs'):
            return cv_id
    return None


def _select_mane(tcs: list[dict]) -> dict | None:
    """VEP marks the MANE Select transcript with `mane_select` populated."""
    for tc in tcs:
        if tc.get('mane_select'):
            return tc
    return None


def _select_caller(tcs: list[dict], caller_transcript: str) -> dict:
    """Match the caller-supplied transcript (versioned or unversioned)."""
    stripped = _strip_version(caller_transcript)
    for tc in tcs:
        if _strip_version(tc.get('transcript_id', '')) == stripped:
            return tc
    raise LookupError(
        f'caller-supplied transcript {caller_transcript!r} not found in VEP '
        f'transcript_consequences (got: '
        f'{[tc.get("transcript_id") for tc in tcs]!r})'
    )


def _select_alternates(tcs: list[dict], exclude_ids: set[str]) -> list[dict]:
    """RefSeq NM_, protein-coding alternates, excluding already-rendered ones."""
    return [
        _project_transcript_compact(tc)
        for tc in tcs
        if tc.get('transcript_id', '').startswith('NM_')
        and tc.get('biotype') in _PROMPT_RELEVANT_BIOTYPES
        and _strip_version(tc.get('transcript_id', '')) not in exclude_ids
    ]


async def normalize_variant(hgvs: str, caller_transcript: str) -> dict:
    """Normalise a single coding-DNA HGVS expression via VEP REST.

    Args:
        hgvs: full HGVS expression in colon-glued form,
            e.g. `NM_001035.3:c.14174A>G`.
        caller_transcript: the transcript supplied by the caller — e.g.
            `NM_001035.3`. Used to decide whether to populate
            `user_transcript` (when it differs from the gene's MANE Select).

    Returns:
        The normalised dict (see module docstring for the canonical shape).

    Raises:
        httpx.HTTPStatusError: VEP REST returned a permanent 4xx error
            (after no further retries).
        ValueError: VEP returned an empty / unexpected response shape.
        LookupError: the caller's transcript wasn't present in VEP's
            `transcript_consequences[]` (caller typo or unindexed
            transcript).
    """
    (annotations, source_version), recoder_rec = await asyncio.gather(
        _fetch_vep(hgvs),
        _fetch_recoder(hgvs),
    )
    if not annotations:
        raise ValueError(f'VEP returned no annotations for {hgvs!r}')

    annotation = annotations[0]
    tcs: list[dict] = annotation.get('transcript_consequences') or []
    if not tcs:
        raise ValueError(f'VEP returned no transcript_consequences for {hgvs!r}')

    mane_entry = _select_mane(tcs)
    caller_entry = _select_caller(tcs, caller_transcript)

    # gene_symbol / hgnc_id: prefer MANE entry, fall back to the caller's.
    primary = mane_entry or caller_entry
    gene_symbol = primary.get('gene_symbol')
    if not gene_symbol:
        raise ValueError(f'VEP returned no gene_symbol for {hgvs!r}')
    hgnc_id = primary.get('hgnc_id')

    # Genomic forms come from the Variant Recoder, not VEP: VEP's HGVS-c
    # endpoint returns no hgvsg and reports allele_string in the transcript's
    # strand (the minus strand for reverse-strand genes), so a forward-strand
    # genomic HGVS can't be derived from it. The Recoder gives the canonical
    # GRCh38 form for SNVs, indels, and splice/intronic variants alike.
    grch38_block = _grch38_from_recoder(recoder_rec, hgvs)

    # user_transcript only when caller's transcript differs from MANE Select.
    user_transcript_block: dict | None = None
    if mane_entry is None or _strip_version(caller_entry['transcript_id']) != _strip_version(
        mane_entry['transcript_id']
    ):
        user_transcript_block = _project_transcript_full(caller_entry)

    # Alternates: exclude MANE and the caller's NM_ — they're already rendered as full blocks.
    exclude_ids: set[str] = set()
    if mane_entry is not None:
        exclude_ids.add(_strip_version(mane_entry['transcript_id']))
    exclude_ids.add(_strip_version(caller_entry['transcript_id']))
    alternates = _select_alternates(tcs, exclude_ids)

    return {
        'schema_version': NORMALIZED_VARIANT_SCHEMA_VERSION,
        'source': 'vep',
        'source_version': source_version,
        'fetched_at': datetime.now(UTC).isoformat().replace('+00:00', 'Z'),
        'gene_symbol': gene_symbol,
        'hgnc_id': hgnc_id,
        'rsid': _select_rsid(annotation),
        'grch38': grch38_block,
        'grch37': None,  # liftover available via /map endpoint; deferred.
        'mane_select': _project_transcript_full(mane_entry) if mane_entry else None,
        'user_transcript': user_transcript_block,
        'alternate_transcripts': alternates,
    }
