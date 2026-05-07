# Fixture paper licenses

The papers under `examples/demo/fixtures/papers/` are real published articles
sourced from the [PMC Open Access Subset](https://pmc.ncbi.nlm.nih.gov/tools/openftlist/).
Each is distributed under a **Creative Commons Attribution 4.0 International
License (CC-BY 4.0)**, which permits redistribution and modification
(including the pipeline's PDF→Markdown conversion) provided appropriate
credit is given.

## Attribution (required by CC-BY 4.0)

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

## Modifications

The PDFs themselves are unmodified. For each paper the fixture additionally
ships derived artifacts produced by the flowa pipeline:

- `markdown.md` — Markdown extracted from the PDF by the conversion stage.
- `metadata.json` — bibliographic metadata (DOI, PMID, title, authors, etc.).

These derivatives are released under the same CC-BY 4.0 terms as the
underlying PDFs.

## Adding new papers

**Verify each paper's license permits redistribution and modification before
staging it under `examples/demo/fixtures/papers/`.** OK: public domain / CC0,
CC-BY (any version), CC-BY-SA. Not OK: CC-BY-ND, CC-BY-NC-ND, CC-BY-NC,
closed-publisher PDFs.

Authoritative checks:

```bash
# CrossRef license metadata
curl -s https://api.crossref.org/works/<DOI> | jq '.message.license'
# PMC OA Subset license (PMC OA membership alone is not sufficient — many
# entries are CC-BY-NC-ND, which is not redistributable here).
curl -s "https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=PMC<id>"
```

Add a new section above with title, authors, DOI, PMID, and license, in the
same commit that adds the paper.
