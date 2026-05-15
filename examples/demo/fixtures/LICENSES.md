# Fixture paper licenses

The fixture under `examples/demo/fixtures/papers/` ships two kinds of entries:

1. **Full-content papers** — PDF + Markdown conversion + metadata. Two papers
   qualify (both CC-BY 4.0); the pipeline downloaded the PDF, converted it to
   Markdown, and ran extraction against them. The Markdown is a derivative
   work; CC-BY 4.0 permits this provided attribution is preserved (below).
2. **Metadata-only papers** — only `metadata.json` (no PDF, no Markdown,
   no abstract). Three papers fall here because their underlying article is
   either not in PMC's Open Access subset or has a redistribution-restricting
   licence (e.g. CC-BY-NC-ND). The DOI, PMID, title, author list, journal,
   and publication date are facts and not copyrightable; the abstract is
   stripped to keep clear of the publisher's copyright on the author's prose.
   The literature page renders these rows as "needs manual upload" — the
   curator drops in a PDF locally; the redistributable repo never carries it.

## Full-content papers (CC-BY 4.0, attribution required)

### `10.1371%2Fjournal.pone.0131517/`

- **Title:** Gender Differences in the Inheritance Mode of RYR2 Mutations in
  Catecholaminergic Polymorphic Ventricular Tachycardia Patients.
- **Authors:** Ohno, Seiko; Hasegawa, Kanae; Horie, Minoru
- **Journal:** PLoS ONE, 2015-06-27
- **DOI:** [10.1371/journal.pone.0131517](https://doi.org/10.1371/journal.pone.0131517)
- **PMID:** 26114861
- **License:** [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)

### `10.1371%2Fjournal.pone.0243476/`

- **Title:** Correction: Gender Differences in the Inheritance Mode of RYR2
  Mutations in Catecholaminergic Polymorphic Ventricular Tachycardia Patients.
- **Authors:** Ohno, Seiko; Hasegawa, Kanae; Horie, Minoru
- **Journal:** PLoS ONE, 2021-02-19
- **DOI:** [10.1371/journal.pone.0243476](https://doi.org/10.1371/journal.pone.0243476)
- **PMID:** 33606749
- **License:** [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)

### Derivative artifacts

For each full-content paper the fixture also ships the pipeline's derivatives:

- `markdown.md` — Markdown extracted from the PDF by the conversion stage.
- `metadata.json` — bibliographic metadata (DOI, PMID, title, authors, etc.).

These derivatives are released under the same CC-BY 4.0 terms as the
underlying PDFs.

## Metadata-only papers (factual bibliographic data)

These rows show up in the demo's literature page as "needs manual upload";
they exist so the page renders the same five DOIs flowa originally queried,
and so a curator running the demo locally can drop in their own PDF copies.

- `10.1253%2Fcircj.cj-12-1460/` — Genetic background of catecholaminergic
  polymorphic ventricular tachycardia in Japan (Kawamura et al., Circ J 2013).
- `10.1161%2FCIRCGEN.116.001424/` — Yield of the RYR2 Genetic Test in Suspected
  CPVT (Kapplinger et al., Circ Genom Precis Med 2018).
- `10.2169%2Finternalmedicine.9843-17/` — Bradycardia Is a Specific Phenotype
  of CPVT Induced by RYR2 Mutations (Miyata et al., Intern Med 2018,
  CC-BY-NC-ND — the source PDF is therefore not redistributed here).

## Adding new papers

**Verify each paper's license before staging anything under
`examples/demo/fixtures/papers/`.**

For full-content (PDF + Markdown + extraction): only CC-BY family (any
version), CC-BY-SA, or public domain / CC0. Not OK for full content:
CC-BY-ND (the PDF→Markdown conversion is a derivative work), CC-BY-NC and
CC-BY-NC-ND (incompatible with the repo's MIT licence), or closed-publisher
PDFs.

For metadata-only (just `metadata.json`): no abstract, no derivative content.
Bibliographic facts (DOI, PMID, title, authors, journal, date) are not
copyrightable and can be shipped regardless of the source paper's licence.
This is the safe path when a paper isn't in the OA subset.

Authoritative checks:

```bash
# CrossRef license metadata
curl -s https://api.crossref.org/works/<DOI> | jq '.message.license'
# PMC OA Subset license (PMC OA membership alone is not sufficient — many
# entries are CC-BY-NC-ND, which is not redistributable here).
curl -s "https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=PMC<id>"
```

Add a new section above with title, authors, DOI, PMID, and license in the
same commit that adds the paper.
