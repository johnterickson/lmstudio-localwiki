# LocalWiki

Supercharge your LLM's knowledge base with self-hosted, fully offline wiki articles powered by Kiwix.

## Features

*   **Expandable & Upgradable**: Expanding and updating your Kiwix library are made trivial with openZIM files.
*   **Intentional Retrieval**: Search for an article, list its sections, then fetch only the relevant section.
*   **Structured Segments**: Article text is cleaned with `cheerio` and returned without the References section. Segments preserve Markdown blocks; tables split only between rows and repeat their headers.
*   **Forgiving Paths**: If an article path returns HTTP 404, underscores are converted to spaces and the value is passed to `wiki_search`; its search results are returned to the model.
*   **Low Overhead**: Unlike RAG-based semantic search, this tool does not require a vector database. It interacts directly with your self-hosted Kiwix endpoint via its `OPDS API`. Since the vast majority of the content resides on disk, this minimal overhead makes it possible to implement on SBCs / mobile devices.

## Limitations

*   Currently does not support images.

## Tools

```text
wiki_search(query)
wiki_sections(path)
wiki_fetch(path, section, segment = 1)
```

`wiki_sections` returns non-empty sections in Wikipedia document order. `wiki_fetch` returns native Markdown and segment metadata. Exact article paths and section IDs are required at this service boundary; callers may layer shorter request-scoped handles over them.

## Installation & Configuration

For a more detailed installation guide with pictures, visit the [GitHub repository](https://github.com/2vibeornot2vibe/lmstudio-localwiki).

### 1. Download Kiwix

**Kiwix Desktop (Recommended for beginners):**
*   **Windows**: [Download Kiwix](https://get.kiwix.org/en/solutions/applications/download-options) and install.
*   **macOS**: Same as Windows. Alternatively, you can get it from the Mac App Store.
*   **Linux**: Install `kiwix-desktop` via your package manager or from Flathub.

**Setup:** Once Kiwix is installed, navigate to "Online Files" to download your desired wiki dumps (e.g., Wikipedia, ArchWiki). Select "Local Kiwix Server" from the drop-down menu in the top-right corner (or press `Ctrl+I`). Set the address to `127.0.0.1` on port `8080` and start the server.
*   *Note:* If non-Wikipedia books do not appear in your book list (a known bug), use **Kiwix Server** instead.

**Kiwix Server (Recommended for headless systems / SBCs):**
*   **Windows & macOS**: [Download Kiwix Server](https://get.kiwix.org/en/solutions/applications/download-options) and install.
*   **Linux**: Install `kiwix-tools` via your package manager.

**Setup:**
1. Download your desired wiki dumps [here](https://library.kiwix.org).
2. Navigate to the directory containing your openZIM files and run:
```bash
kiwix-serve -i 127.0.0.1 -p 8080 *.zim
```
You may also pass the `-d` flag to run the server as a background daemon.

### 2. Download and Configure this Tool

**Terminal Setup:**
Assuming you did not uncheck the "add `lms` to your PATH" option during LM Studio's setup, run:
```bash
lms get 2vibeornot2vibe/localwiki
```

**Tool Activation:**
1. Once installed, click the sidebar button in the top-right corner of the LM Studio UI.
2. Enable this tool. 
3. You may also adjust its configurations (mainly search/fetch limiters) in the drop-down menu if needed.

Your LLM is now ready to read articles from your Kiwix library!

## Credits

This tool is a fork of [lmstudio/wikipedia](https://lmstudio.ai/lmstudio/wikipedia) and is mainly authored/enhanced by **DeepSeek-V4** and **DeepSeek-V3.3**, with the code audited by me.

**Disclaimer:** This is just a for-fun weekend project and should **NOT** be used in production environments. This tool is provided "as is" with **NO WARRANTY**.

Feedbacks and contributions to this project are welcome! :D

## License

This tool is released under the [GPLv3 license](https://www.gnu.org/licenses/gpl-3.0.html).