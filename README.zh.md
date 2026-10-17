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

没有文字层的扫描版不能读。本插件不做 OCR。模型写出的页码和结论需要对照 PDF。

## 数据放在哪里

| 内容 | 位置 |
|---|---|
| 论文、PDF、报告、追问、札记、图谱 | 你电脑上选定的论文目录 |
| 元数据和引用关系 | 你发起查询时访问 arXiv、Crossref、OpenAlex |
| 精读、追问、图解 | DeepSeek Harness 里配置的模型 |
| 设置 | 你电脑上的 `~/.dsh/scholar-config.json` |

插件自己不采集使用数据。`/scholar/*` 只接受本机连接。

## 许可证

[MIT](LICENSE) · [更新记录](CHANGELOG.md)
