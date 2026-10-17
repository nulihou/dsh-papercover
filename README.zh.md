# dsh-papercover

[English](README.md) | [简体中文](README.zh.md)

[DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) 里的论文库和精读工作台。论文、PDF、阅读报告、追问、札记和知识图谱放在同一个侧栏里。

刚安装时是空的。本仓库和 Release 压缩包里只有插件本身，没有论文、PDF、笔记、报告、密钥，也没有任何人的论文库。安装之后，你的文件写在本机你自己选定的目录里。默认目录是 `~/Documents/ResearchPapers`，一开始是空文件夹。

## 主界面

![论文库](docs/main.png)

## 安装

需要 DeepSeek Harness，以及 Node.js 20 或更新版本。

用 Release 压缩包：

```sh
dsh plugin --profile web add ./dsh-papercover-0.3.3.tgz
```

用源码：

```sh
git clone https://github.com/nulihou/dsh-papercover.git
cd dsh-papercover
npm ci
npm run build
dsh plugin --profile web add .
```

安装或升级后，完全退出 DeepSeek Harness 再打开。克隆路径尽量不要包含空格。

## 能做什么

- 手动添加论文，或让对话调用 `paper_save`。arXiv、DOI 和标题用来识别重复条目。
- 上传本地 PDF，或为带 arXiv 编号的论文下载 PDF。单个文件上限 50MB。
- 在侧栏阅读：高亮、批注、划词翻译、大纲。
- 精读、轻量综合或速读。报告保留结论、证据、实验、图、局限和页码链接。
- 按已经保存的正文继续追问。
- 多篇对照。
- 札记和知识图谱（论文、概念、想法）。
- 复制 GB/T 7714、APA 或 BibTeX。
- 与 Zotero Desktop 双向同步。见 [Zotero](#zotero)。

没有文字层的扫描版不能读。本插件不做 OCR。模型写出的页码和结论需要对照 PDF。

## Zotero

dsh-papercover 和 Zotero Desktop 10 及以上双向同步，走 Zotero 本机接口。默认地址是 `http://127.0.0.1:23119/api`。

1. 在 Zotero 里打开 **允许其他应用程序与 Zotero 通信**。
2. 在 dsh-papercover 设置的 **Zotero 双向同步** 里点 **授权写权限**。
3. 在 Zotero 弹出的对话框里选 **始终允许**。只点一次「允许」的话，第一次写入后密钥就失效，后面的库推不出去。

论文库上的 **同步 Zotero** 会先从 Zotero 拉取，再把本地改动推回去。设置里还可以选 **仅拉取** 或 **仅推送**。拉取不需要写密钥，推送需要上面第 2 步的授权。

| 内容 | 方向 |
|---|---|
| 论文元数据：标题、作者、年份、刊物、DOI、摘要、标签 | 双向 |
| 主题分区（Zotero 合集） | 双向 |
| PDF 附件 | 双向 |
| 笔记 | 双向 |
| 札记 | 双向。从这里推出去的札记放进名为 `dsh-papercover/Ideas` 的 Zotero 合集 |
| 高亮 | 双向。Zotero 里划在 PDF 附件上的高亮会回到同一页 |

较短的分区名如果是较长名字的前缀，会当成同一个分区，只保留较长的名字，侧栏不会两条都显示。

同一篇论文在上次同步之后两边都改过，保留较新的那次修改，另一边记为冲突。两边条目的对应关系写在论文目录里的 `zotero-map.json`。写密钥写在你电脑上的 `~/.dsh/scholar-config.json`。这两个文件都不在本仓库里。

## 数据放在哪里

| 内容 | 位置 |
|---|---|
| 论文、PDF、报告、追问、札记、图谱 | 你电脑上选定的论文目录 |
| 元数据和引用关系 | 你发起查询时访问 arXiv、Crossref、OpenAlex |
| 精读、追问、图解 | DeepSeek Harness 里配置的模型 |
| 设置，包括 Zotero 写密钥 | 你电脑上的 `~/.dsh/scholar-config.json` |
| 与 Zotero 的条目对应关系 | 论文目录里的 `zotero-map.json` |

插件自己不采集使用数据。`/scholar/*` 只接受本机连接。

## 许可证

[MIT](LICENSE) · [更新记录](CHANGELOG.md)
