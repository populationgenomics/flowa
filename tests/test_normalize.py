"""Tests for the VEP + Variant Recoder normaliser.

The `grch38` block must be forward-strand even when the gene is on the minus
strand. VEP reports `allele_string` in the transcript's strand, so the Variant
Recoder is the source of truth for genomic forms. GJB2 c.101T>C (minus strand)
is the regression case: coding `T>C` must yield genomic `A>G`, not `T>C` — the
strand-naive construction this replaced sent `g.…T>C` to Mastermind and got
zero papers for every minus-strand variant.
"""

import flowa.normalize as normalize

# Minimal VEP response for GJB2 NM_004004.6:c.101T>C (minus strand). Only the
# fields the normaliser reads. `allele_string` is strand-relative (`T/C`) on
# purpose — the genomic alleles must come from the Recoder, not from here.
_GJB2_VEP = [
    {
        'seq_region_name': '13',
        'start': 20189481,
        'strand': -1,
        'allele_string': 'T/C',
        'transcript_consequences': [
            {
                'transcript_id': 'NM_004004.6',
                'gene_symbol': 'GJB2',
                'hgnc_id': 'HGNC:4284',
                'hgvsc': 'NM_004004.6:c.101T>C',
                'hgvsp': 'NP_003995.2:p.Met34Thr',
                'mane_select': 'ENST00000382848.5',
                'biotype': 'protein_coding',
                'exon': '2/2',
                'consequence_terms': ['missense_variant'],
            }
        ],
        'colocated_variants': [{'id': 'rs35887622'}],
    }
]

# Variant Recoder allele record for the same variant: forward-strand genomic
# forms (NC_ primary + LRG_ alternate we must ignore).
_GJB2_RECODER = {
    'hgvsg': ['NC_000013.11:g.20189481A>G', 'LRG_1350:g.8495T>C'],
    'spdi': ['NC_000013.11:20189480:A:G', 'LRG_1350:8494:T:C'],
}


def _patch(monkeypatch, vep, recoder):
    async def fake_vep(hgvs):
        return vep, '114'

    async def fake_recoder(hgvs):
        return recoder

    monkeypatch.setattr(normalize, '_fetch_vep', fake_vep)
    monkeypatch.setattr(normalize, '_fetch_recoder', fake_recoder)


async def test_minus_strand_genomic_is_forward_strand(monkeypatch):
    _patch(monkeypatch, _GJB2_VEP, _GJB2_RECODER)

    result = await normalize.normalize_variant('NM_004004.6:c.101T>C', 'NM_004004.6')

    g = result['grch38']
    # Coding T>C on the minus strand is genomic A>G — never the strand-relative T>C.
    assert g['hgvs_g'] == 'NC_000013.11:g.20189481A>G'
    assert (g['chrom'], g['pos'], g['ref'], g['alt']) == ('13', 20189481, 'A', 'G')
    assert result['gene_symbol'] == 'GJB2'
    assert result['rsid'] == 'rs35887622'
    assert result['mane_select']['transcript_id'] == 'NM_004004.6'


async def test_recoder_indel_uses_spdi_sequences(monkeypatch):
    # COL4A3 c.5010_*14del — an indel; the old SNV-only construction raised here.
    vep = [
        {
            'seq_region_name': '2',
            'start': 227311867,
            'strand': 1,
            'allele_string': 'CTGAAGCTAAAAAAGACA/-',
            'transcript_consequences': [
                {
                    'transcript_id': 'NM_000091.5',
                    'gene_symbol': 'COL4A3',
                    'hgvsc': 'NM_000091.5:c.5010_*14del',
                    'biotype': 'protein_coding',
                    'mane_select': 'ENST00000396625.8',
                    'consequence_terms': ['3_prime_UTR_variant'],
                }
            ],
            'colocated_variants': [],
        }
    ]
    recoder = {
        'hgvsg': ['NC_000002.12:g.227311867_227311884del', 'LRG_230:g.152303_152320del'],
        'spdi': ['NC_000002.12:227311866:CTGAAGCTAAAAAAGACA:', 'LRG_230:152302:CTGAAGCTAAAAAAGACA:'],
    }
    _patch(monkeypatch, vep, recoder)

    result = await normalize.normalize_variant('NM_000091.5:c.5010_*14del', 'NM_000091.5')

    g = result['grch38']
    assert g['hgvs_g'] == 'NC_000002.12:g.227311867_227311884del'
    assert (g['chrom'], g['pos'], g['ref'], g['alt']) == ('2', 227311867, 'CTGAAGCTAAAAAAGACA', '')
