# Fixture paper licenses

The fixture under `examples/demo/fixtures/papers/` ships three kinds of entries, all keyed by the encoded DOI:

1. **Full-content papers** (15) — `source.pdf` + `markdown.md` + `metadata.json`. The pipeline downloaded the PDF from PMC, converted it to Markdown, and ran extraction. Three also carry `source.md` (the PDF transcription) and a `supplements/` directory of xlsx/docx supplements, which are converted and appended into `markdown.md`. All are CC-BY (any version) or CC0, so the PDF, the derivative Markdown, and the supplements are redistributable provided attribution is preserved (entries below).
2. **Metadata-only, license-restricted** (5) — only `metadata.json`; the source paper is paywalled or under a no-derivatives / non-commercial licence (e.g. CC-BY-NC-ND). The `abstract` field is replaced with a sentinel string explaining the omission, since the abstract is the author's prose and is subject to publisher copyright. Bibliographic facts (DOI, PMID, title, authors, journal, date) are not copyrightable and ship as-is.
3. **Metadata-only, CC-BY not in PMC** (1) — only `metadata.json`; the source paper IS CC-BY-licensed but PMC's OA subset doesn't carry it, so flowa's PMC-only download path silently skipped it. Abstract is preserved (CC-BY permits redistribution); PDF/Markdown are absent. A curator running the demo locally can fetch the PDF from the journal site.

For all three kinds, the demo's literature page renders the row from `metadata.json`; rows without `source.pdf` show as "needs manual upload."

## Full-content papers, CC-BY (attribution required) — 15 entries

### `10.1186%2Fs13023-023-02848-6/`

- **Title:** Genotype, phenotype and treatment outcomes of 17 Malaysian patients with infantile-onset Pompe disease and the identification of 3 novel GAA variants.
- **Authors:** Chan, Mei-Yan; Jalil, Julaina Abdul; Yakob, Yusnita; Wahab, Siti Aishah Abdul; Ali, Ernie Zuraida; Khalid, Mohd Khairul Nizam Mohd; Leong, Huey-Yin; Chew, Hui-Bein; Sivabalakrishnan, Jeya Bawani; Ngu, Lock-Hock
- **Journal:** Orphanet journal of rare diseases, 2023-08-04
- **DOI:** [10.1186/s13023-023-02848-6](https://doi.org/10.1186/s13023-023-02848-6)
- **PMID:** 37542277
- **License:** [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)

### `10.3389%2Ffimmu.2024.1336599/`

- **Title:** Optimizing treatment outcomes: immune tolerance induction in Pompe disease patients undergoing enzyme replacement therapy.
- **Authors:** Chen, Hui-An; Hsu, Rai-Hseng; Fang, Ching-Ya; Desai, Ankit K; Lee, Ni-Chung; Hwu, Wuh-Liang; Tsai, Fuu-Jen; Kishnani, Priya S; Chien, Yin-Hsiu
- **Journal:** Frontiers in immunology, 2024-05-08
- **DOI:** [10.3389/fimmu.2024.1336599](https://doi.org/10.3389/fimmu.2024.1336599)
- **PMID:** 38715621
- **License:** [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)

### `10.1186%2Fs13023-021-01817-1/`

- **Title:** Hearing characteristics of infantile-onset Pompe disease after early enzyme-replacement therapy.
- **Authors:** Hsueh, Chien-Yu; Huang, Chii-Yuan; Yang, Chia-Feng; Chang, Chia-Chen; Lin, Wei-Sheng; Cheng, Hsiu-Lien; Wu, Shang-Liang; Cheng, Yen-Fu; Niu, Dau-Ming
- **Journal:** Orphanet journal of rare diseases, 2021-08-06
- **DOI:** [10.1186/s13023-021-01817-1](https://doi.org/10.1186/s13023-021-01817-1)
- **PMID:** 34353347
- **License:** [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)

### `10.3389%2Ffphar.2022.903488/`

- **Title:** A Multi-Centre Prospective Study of the Efficacy and Safety of Alglucosidase Alfa in Chinese Patients With Infantile-Onset Pompe Disease.
- **Authors:** Zhu, Diqi; Zhu, Jiacong; Qiu, Wenjuan; Wang, Benzhen; Liu, Lin; Yu, Xiaodan; Ou, Zhenheng; Shan, Guangsong; Wang, Jian; Li, Bin; Chen, Xiaokang; Liu, Cong; Li, Zipu; Fu, Lijun
- **Journal:** Frontiers in pharmacology, 2022-07-14
- **DOI:** [10.3389/fphar.2022.903488](https://doi.org/10.3389/fphar.2022.903488)
- **PMID:** 35833019
- **License:** [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)

### `10.1038%2Fs41598-022-25914-8/`

- **Title:** CRISPR-mediated generation and characterization of a Gaa homozygous c.1935C>A (p.D645E) Pompe disease knock-in mouse model recapitulating human infantile onset-Pompe disease.
- **Authors:** Kan, Shih-Hsin; Huang, Jeffrey Y; Harb, Jerry; Rha, Allisandra; Dalton, Nancy D; Christensen, Chloe; Chan, Yunghang; Davis-Turak, Jeremy; Neumann, Jonathan; Wang, Raymond Y
- **Journal:** Scientific reports, 2022-12-14
- **DOI:** [10.1038/s41598-022-25914-8](https://doi.org/10.1038/s41598-022-25914-8)
- **PMID:** 36517654
- **License:** [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- **Supplement:** `supplements/000_41598_2022_25914_MOESM1_ESM.docx` (electronic supplementary material; inherits the article's CC-BY 4.0).

### `10.3389%2Ffcvm.2022.1061384/`

- **Title:** Induced pluripotent stem cell for modeling Pompe disease.
- **Authors:** Huang, Wenjun; Zhang, Yanmin; Zhou, Rui
- **Journal:** Frontiers in cardiovascular medicine, 2023-01-09
- **DOI:** [10.3389/fcvm.2022.1061384](https://doi.org/10.3389/fcvm.2022.1061384)
- **PMID:** 36620633
- **License:** [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)

### `10.3390%2Fijns11010016/`

- **Title:** Five-Year Outcomes of Patients with Pompe Disease Identified by the Pennsylvania Newborn Screen.
- **Authors:** Ron, Hayley A; Kane, Owen; Guo, Rose; Menello, Caitlin; Engelhardt, Nicole; Pressley, Shaney; DiBoscio, Brenda; Steffensen, Madeline; Cuddapah, Sanmati; Ng, Kim; Ficicioglu, Can; Ahrens-Nicklas, Rebecca C
- **Journal:** International journal of neonatal screening, 2025-03-26
- **DOI:** [10.3390/ijns11010016](https://doi.org/10.3390/ijns11010016)
- **PMID:** 40136631
- **License:** [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)

### `10.3389%2Ffcvm.2023.1261172/`

- **Title:** Pompe disease in China: clinical and molecular characteristics.
- **Authors:** Li, Jing; Shi, Xiaohe; Wang, Bo; Hsi, David H; Zhu, Xiaoli; Ta, Shengjun; Wang, Jing; Lei, Changhui; Hu, Rui; Huang, Junzhe; Zhao, Xueli; Liu, Liwen
- **Journal:** Frontiers in cardiovascular medicine, 2024-01-01
- **DOI:** [10.3389/fcvm.2023.1261172](https://doi.org/10.3389/fcvm.2023.1261172)
- **PMID:** 38162137
- **License:** [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- **Supplement:** `supplements/000_Table1.docx` (supplementary tables of patient demographics + biochemical indicators; inherits the article's CC-BY 4.0).

### `10.1186%2Fs13023-021-02146-z/`

- **Title:** Current status of newborn screening for Pompe disease in Japan.
- **Authors:** Sawada, Takaaki; Kido, Jun; Sugawara, Keishin; Momosaki, Ken; Yoshida, Shinichiro; Kojima-Ishii, Kanako; Inoue, Takahito; Matsumoto, Shirou; Endo, Fumio; Ohga, Shouichi; Hirose, Shinichi; Nakamura, Kimitoshi
- **Journal:** Orphanet journal of rare diseases, 2021-12-19
- **DOI:** [10.1186/s13023-021-02146-z](https://doi.org/10.1186/s13023-021-02146-z)
- **PMID:** 34922579
- **License:** [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)

### `10.1002%2Fhumu.23878/`

- **Title:** GAA variants and phenotypes among 1,079 patients with Pompe disease: Data from the Pompe Registry.
- **Authors:** Reuser, Arnold J J; van der Ploeg, Ans T; Chien, Yin-Hsiu; Llerena, Juan; Abbott, Mary-Alice; Clemens, Paula R; Kimonis, Virginia E; Leslie, Nancy; Maruti, Sonia S; Sanson, Bernd-Jan; Araujo, Roberto; Periquet, Magali; Toscano, Antonio; Kishnani, Priya S; On Behalf Of The Pompe Registry Sites
- **Journal:** Human mutation, 2019-07-26
- **DOI:** [10.1002/humu.23878](https://doi.org/10.1002/humu.23878)
- **PMID:** 31342611
- **License:** [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)

### `10.1186%2Fs12881-019-0878-8/`

- **Title:** Clinical course, mutations and its functional characteristics of infantile-onset Pompe disease in Thailand.
- **Authors:** Ngiwsara, Lukana; Wattanasirichaigoon, Duangrurdee; Tim-Aroon, Thipwimol; Rojnueangnit, Kitiwan; Noojaroen, Saisuda; Khongkraparn, Arthaporn; Sawangareetrakul, Phannee; Ketudat-Cairns, James R; Charoenwattanasatien, Ratana; Champattanachai, Voraratt; Kuptanon, Chulaluck; Pangkanon, Suthipong; Svasti, Jisnuson
- **Journal:** BMC medical genetics, 2019-09-13
- **DOI:** [10.1186/s12881-019-0878-8](https://doi.org/10.1186/s12881-019-0878-8)
- **PMID:** 31510962
- **License:** [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)

### `10.1016%2Fj.ymgmr.2024.101163/`

- **Title:** Efficacy and safety of avalglucosidase alfa in Japanese patients with late-onset and infantile-onset Pompe diseases: A case series from clinical trials.
- **Authors:** Mori-Yoshimura, Madoka; Ohki, Hirotaka; Mashimo, Hideaki; Inoue, Kenji; Kumada, Satoko; Kiyono, Takashi; Arimori, Akihiro; Ikeda, Mitsunobu; Komaki, Hirofumi
- **Journal:** Molecular genetics and metabolism reports, 2025-01-21
- **DOI:** [10.1016/j.ymgmr.2024.101163](https://doi.org/10.1016/j.ymgmr.2024.101163)
- **PMID:** 39835171
- **License:** [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- **Supplement:** `supplements/000_mmc1.docx` (electronic supplementary material; inherits the article's CC-BY 4.0).

### `10.1186%2Fs13052-019-0692-0/`

- **Title:** Comprehensive approach to weaning in difficult-to-wean infantile and juvenile-onset glycogen-storage disease type II patients: a case series.
- **Authors:** Xu, Lingling; Ba, Hongjun; Pei, Yuxin; Huang, Xueqiong; Liang, Yujian; Zhang, Lidan; Huang, Huimin; Zhang, Cheng; Tang, Wen
- **Journal:** Italian journal of pediatrics, 2019-08-24
- **DOI:** [10.1186/s13052-019-0692-0](https://doi.org/10.1186/s13052-019-0692-0)
- **PMID:** 31439017
- **License:** [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)

### `10.3390%2Fijns6020031/`

- **Title:** Newborn Screening for Pompe Disease.
- **Authors:** Sawada, Takaaki; Kido, Jun; Nakamura, Kimitoshi
- **Journal:** International journal of neonatal screening, 2020-10-19
- **DOI:** [10.3390/ijns6020031](https://doi.org/10.3390/ijns6020031)
- **PMID:** 33073027
- **License:** [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)

### `10.3389%2Ffped.2021.729824/`

- **Title:** Case Report: Anesthetic Management and Electrical Cardiometry as Intensive Hemodynamic Monitoring During Cheiloplasty in an Infant With Enzyme-Replaced Pompe Disease and Preserved Preoperative Cardiac Function.
- **Authors:** Liu, Meng-Chen; Wang, Ming-Tse; Chen, Philip Kuo-Ting; Niu, Dau-Ming; Fan Chiang, Yu-Hsuan; Hsieh, Ming-Hui; Tsai, Hsiao-Chien
- **Journal:** Frontiers in pediatrics, 2021-12-30
- **DOI:** [10.3389/fped.2021.729824](https://doi.org/10.3389/fped.2021.729824)
- **PMID:** 34966699
- **License:** [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)

### Derivative artifacts

For each full-content paper the fixture also ships the pipeline's derivatives:

- `markdown.md` — Markdown extracted from the PDF by the conversion stage.
- `metadata.json` — bibliographic metadata (DOI, PMID, title, authors, etc.).

These derivatives are released under the same CC-BY licence as the underlying PDFs.

## Metadata-only, license-restricted (5 entries)

Rows render in the literature page as "needs manual upload" — a curator running the demo locally can drop in their own PDF copy; the redistributable repo never carries it.

- `10.1136%2Fjmg-2022-108675/` — Long-term outcomes of very early treated infantile-onset Pompe disease with short-term steroid premedication: experiences from a nationwide newborn screening programme (Yang et al., Journal of medical genetics 2022).
- `10.1016%2Fj.tjog.2022.07.008/` — Retrospective analysis of prenatal ultrasound of children with Pompe disease (Li et al., Taiwanese journal of obstetrics & gynecology 2022) (CC-BY-NC-ND — source PDF is not redistributable here).
- `10.1016%2Fj.ejmg.2020.103997/` — Clinical and GAA gene mutation analysis in 21 Chinese patients with classic infantile pompe disease (Su et al., European journal of medical genetics 2020).
- `10.1093%2Fhmg%2Fddz218/` — Using human Pompe disease-induced pluripotent stem cell-derived neural cells to identify compounds with therapeutic potential (Huang et al., Human molecular genetics 2019).
- `10.1002%2Fajmg.a.61481/` — Airway abnormalities in very early treated infantile-onset Pompe disease: A large-scale survey by flexible bronchoscopy (Yang et al., American journal of medical genetics. Part A 2020).

## Metadata-only, CC-BY but absent from PMC (1 entry)

The source paper is CC-BY-licensed and may be downloaded from the journal's open-access page; PMC's OA subset just doesn't carry it, so flowa's download step skipped it. Abstract is preserved.

- `10.1016%2Fj.nmd.2022.02.002/` — Safety and effectiveness of resistance training in patients with late onset Pompe disease - a pilot study (Bhatnagar et al., Neuromuscular disorders 2022) (CC-BY but not in PMC — abstract retained, no PDF/Markdown shipped).

## Adding new papers

**Verify each paper's license before staging anything under `examples/demo/fixtures/papers/`.**

For full-content (PDF + Markdown + extraction): only CC-BY family (any version), CC-BY-SA, or public domain / CC0. Not OK for full content: CC-BY-ND (the PDF→Markdown conversion is a derivative work), CC-BY-NC and CC-BY-NC-ND (incompatible with the repo's MIT licence), or closed-publisher PDFs.

For metadata-only entries, replace the `abstract` field with the sentinel rather than deleting it, so the omission reads as deliberate (see `examples/demo/README.md` → "Capturing a fixture" for the exact snippet). Bibliographic facts (DOI, PMID, title, authors, journal, date) ship as-is regardless of the source paper's licence.

Authoritative checks:

```bash
# CrossRef license metadata
curl -s https://api.crossref.org/works/<DOI> | jq '.message.license'
# PMC OA Subset license (PMC OA membership alone is not sufficient —
# many entries are CC-BY-NC-ND, which is not redistributable here).
curl -s "https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=PMC<id>"
```

Add a new section above with title, authors, DOI, PMID, and license in the same commit that adds the paper.
