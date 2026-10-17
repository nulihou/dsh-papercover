# dsh-papercover

[English](README.md) | [简体中文](README.zh.md)

Paper library and close-reading workspace for [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh). Keep papers, PDFs, reading reports, questions, idea cards, and a knowledge graph in one sidebar.

A fresh install is empty. This repository and the release archive contain the plugin only. They do not include papers, PDFs, notes, reports, API keys, or anyone's library. After you install it, your own files are created on your machine, under the archive directory you choose in settings. The default directory is `~/Documents/ResearchPapers`, and it starts empty.

## Main screen

![Library](docs/main.png)

## Install

Requires DeepSeek Harness and Node.js 20 or newer.

From the release archive:

```sh
dsh plugin --profile web add ./dsh-papercover-0.3.3.tgz
```

From source:

```sh
git clone https://github.com/nulihou/dsh-papercover.git
cd dsh-papercover
npm ci
npm run build
dsh plugin --profile web add .
```

Quit DeepSeek Harness completely and open it again after installing or upgrading. Prefer a clone path that contains no spaces.

## What you can do

- Save papers by hand, or ask the agent to call `paper_save`. arXiv ids, DOIs, and titles are used to spot duplicates.
- Upload a local PDF, or download the PDF for an arXiv paper. The upload limit is 50MB per file.
- Read in the sidebar: highlights, notes, word translation, and page outline.
- Run a close reading, a lighter synthesis, or a skim. Reports keep claims, evidence, experiments, figures, limits, and page links.
- Ask follow-up questions against the saved paper text.
- Compare several papers.
- Keep idea cards and a knowledge graph of papers, concepts, and ideas.
- Copy citations as GB/T 7714, APA, or BibTeX.
- Sync both ways with Zotero Desktop. See [Zotero](#zotero).

Scanned PDFs without a text layer cannot be read. This plugin does not run OCR. Check model-written page numbers and claims against the PDF.

## Zotero

dsh-papercover syncs both ways with Zotero Desktop 10 or newer, through Zotero’s local connector. The default address is `http://127.0.0.1:23119/api`.

1. In Zotero, turn on **Allow other applications to communicate with Zotero**.
2. In dsh-papercover settings, under **Zotero sync**, choose **Authorize writes**.
3. In the Zotero dialog, choose **Always Allow**. A one-time Allow expires after the first write, so the rest of the library cannot be pushed.

The **Sync Zotero** button on the library runs both directions: pull from Zotero, then push local changes. Settings also has **Pull only** and **Push only**. Pull works without a write key. Push needs the key from step 2.

| What | Direction |
|---|---|
| Paper metadata: title, authors, year, venue, DOI, abstract, tags | Both |
| Collections (主题分区) | Both |
| PDF attachments | Both |
| Notes | Both |
| Idea cards | Both. Cards pushed from here land in a Zotero collection named `dsh-papercover/Ideas` |
| Highlights | Both. Zotero highlights on the PDF attachment come back onto the same pages |

A shorter collection name that is a prefix of a longer one is treated as the same collection. The longer name is kept, so the sidebar does not list both.

If the same paper was edited on both sides after the last sync, the newer edit is kept and the other side is counted as a conflict. The link between the two libraries is stored in `zotero-map.json` inside your archive directory. The write key stays in `~/.dsh/scholar-config.json` on your computer. Neither file is in this repository.

## Where data lives

| Item | Where it goes |
|---|---|
| Papers, PDFs, reports, questions, cards, graph | The archive directory on your computer |
| Metadata and citation links | arXiv, Crossref, and OpenAlex, when you ask for them |
| Close reading, questions, figure descriptions | The model configured in DeepSeek Harness |
| Settings, including the Zotero write key | `~/.dsh/scholar-config.json` on your computer |
| Zotero item map | `zotero-map.json` inside the archive directory |

The plugin has no telemetry of its own. `/scholar/*` routes accept loopback connections only.

## License

[MIT](LICENSE) · [Changelog](CHANGELOG.md)
