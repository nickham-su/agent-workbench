# 格式、路径与资源规则

本文件是格式、源请求路径、包内路径、配额和权限的唯一规则源。工程默认值已按负责人审查裁定收敛，不代表用户逐项指定，也不代表真实环境测试已完成。

## 后缀与库兼容边界

| 后缀（大小写不敏感） | 解析路线 | 首期范围 |
|---|---|---|
| `.zip` | `yauzl` + 文件内容 CRC32 校验 | 单卷、非加密，stored/deflate，含限额内 ZIP64 |
| `.tar` | 有界 TAR 流 → `tar` 包公开 `Parser` | 普通文件、目录、库支持的 PAX/GNU 名称/尺寸扩展 |
| `.tar.gz`、`.tgz` | 一次外部 `node:zlib` gzip 解压 → 有界 TAR 流 → `Parser` | 外层 gzip 与 Parser 均成功结束 |

- 后缀选择解析路线，不自动换其他解析器“救活”内容。普通 `.gz`、其他 TAR 压缩后缀、RAR、7Z 返回 `ARCHIVE_FORMAT_UNSUPPORTED`。
- 格式兼容性继承选定库的公开行为及错误；内容 CRC、源请求安全、包内路径/类型、配额和不覆盖规则由本功能补充，不由库容忍度决定。
- 不自研 ZIP/TAR 原始格式扫描器。不额外承诺拒绝 SFX、ZIP 任意尾随数据、全部局部/中央头不一致、TAR 缺少精确两零块、非规范填充或第二份 TAR。库可能接受的非规范结构可以接受；库公开输出的所有有效条目仍逐项受本文件约束。
- 库报格式/截断/校验错误、非法或不安全整数尺寸、应用层文件 CRC 错误，以及可确定的内容错配，返回 `ARCHIVE_INVALID`。不能把“库没有严格检查的结构”写成必定报损坏。
- 没有合法格式结构的零字节源拒绝；库接受的合法空 ZIP/空 TAR 成功返回零计数。空目录作为实际节点保留，不属于零结果。
- 解析前，输入快照已由源句柄流式完整复制并验证。后续读取方式按格式区分，不把完整快照复制等同于解析器逐字节读取全部原始数据。
- ZIP 使用 yauzl 随机访问；成功要求惰性枚举结束（`end`）、所有需解出文件的内容流/写流、尺寸及 CRC 校验完成，库关闭并且错误收敛。不承诺每个 ZIP 原始字节均被解析读取，不为此另扫前缀或尾部。
- TAR/gzip 成功必须完整消费顺序输入，外层 gzip（若有）结束且通过校验，Parser 和全部输出写流完成；不能在最后一个 entry 结束时提前成功。失败可提前停止并清理，不强迫继续读取恶意包。

## ZIP：固定使用 yauzl 公开接口

- 基线为 `yauzl@3.4.0`，设置 `lazyEntries: true`、`decodeStrings: true`、`validateEntrySizes: true`、`strictFileNames: true`；逐项枚举、逐文件打开流，等待处理结束后再 `readEntry()`。
- 使用库标准文件名解码：UTF-8、CP437、经校验的 Info-ZIP Unicode Path extra field；不自行扫描原始名称/头或重写库解码器。
- **标准 CP437 是支持范围**。不猜测 GBK；未按 ZIP 约定标记的 GBK 字节可能按 CP437 解码，不能保证恢复其原字节语义，也不能声称能自动识别并报“不支持编码”。
- 畸形 UTF-8、额外字段选择及替换字符行为继承库默认 decoder，不额外承诺严格 UTF-8 拒绝。无论如何解码，最终 `entry.fileName` 必须走相同路径、重复与实际 FS 别名检查。
- `strictFileNames` 禁止库把反斜杠宽松替换为斜杠；回调前的库解析错误统一 `ARCHIVE_INVALID`，公开 entry 到达后本功能发现的非法名称为 `ARCHIVE_ENTRY_INVALID`，不依赖解析第三方 message 来强分错误。不为无法可靠识别的字节编码设置产品专用错误码。
- `yauzl` 的尺寸校验不等于 CRC 校验：普通文件每块用 `buffer-crc32` 的 `crc32.unsigned(chunk, partialCrc)` 累计，空文件初值为 `0`；与 `entry.crc32` 的 unsigned 值比较。错误即整包拒绝。
- ZIP64 数字必须是安全整数且满足配额；从公开条目可判断的加密/分卷/不支持方法为 `ARCHIVE_FEATURE_UNSUPPORTED`。若库先拒绝则沿用 `ARCHIVE_INVALID`，不解析 message 强分原因，也不增加密码交互。
- 从 Unix external attributes 判别对象类型：链接、设备、FIFO、socket 等拒绝；无可靠 Unix type 或普通 DOS 文件按普通文件处理。目录尾斜线与明确文件类型冲突、目录非零输出等可观察矛盾拒绝。
- 不要求补做完整局部/中央头一致性扫描。库自身公开校验失败转安全格式错误；库可解析的条目不得跳过安全校验。

## TAR：固定使用 node-tar Parser，不解包到目录

```ts
import { Parser } from "tar";

const parser = new Parser({
  strict: true,
  maxMetaEntrySize: 64 * 1024,
  brotli: false,
  zstd: false
});
```

- 源码基线为 `tar@7.5.22`。导出名是 **`Parser`，不是 `Parse`**；不用 `tar.x`、`tar.t` 或内部 Symbol。适配器使用公开 `entry`、`ignoredEntry`、`meta`、`error`、`abort(error)`，输入/背压/完成按公开流接口协调。
- `entry` 只接受 `File`、`OldFile`、`Directory`，检查库已经应用 PAX/GNU 的最终 `entry.path`、`entry.size` 与 mode。条目初始暂停，按背压逐流消费，写入和校验完成后才继续后续条目。
- 归档 hardlink、symlink、设备、FIFO、contiguous、GNU sparse 及未知输出类型均整包拒绝；不要把 Parser 忽略的条目当成功跳过。
- **任何 `ignoredEntry` 都失败**。尤其超过 `maxMetaEntrySize` 的元数据会被 `ignoredEntry` 忽略，`strict: true` 本身不会替适配器报错。若其公开类型与 size 明确表示扩展体超额，转 `ARCHIVE_LIMIT_EXCEEDED`；其余转 `ARCHIVE_ENTRY_UNSUPPORTED`。
- `meta` 给出有界原始文本，在扩展应用并处理下一普通 entry 前可观察。同步累计元数据额度，保守拒绝含 `GNU.sparse.`、`SCHILY.realsize`、`SCHILY.filetype=sparse` 的文本，转 `ARCHIVE_ENTRY_UNSUPPORTED`；触发后立即 `abort(error)`，不等待下一项写入。
- 该 sparse 标记检查可能误拒仅在描述文本中出现同样标记的包；这是为避免自研完整 PAX 解析器接受的兼容取舍。不能指望最终 `entry.extended` 还保留这些键。
- `node-tar` 的 `Pax.parse` 仅保留固定键，丢弃未知键，不无限累积任意全局 PAX 键。本功能不另建全局元数据字典，也不解析一套完整 PAX 语法。
- owner、时间、ACL、xattr 不恢复；文件名解码、头校验、扩展选择及非规范结束结构按 Parser 的公开行为，不自行扫描填充/原始物理头，也不额外承诺畸形 UTF-8 必拒绝。

### gzip 自动识别的计量边界

- `brotli: false`、`zstd: false` **不能禁用 Parser 自动识别 gzip**。只配置这两个选项不足以保证 `.tar` 不接受 gzip。
- `.tar` 直接流入 TAR 字节计量层；`.tar.gz`/`.tgz` 仅在外部解 gzip 一次，再进入同一计量层；不落中间 TAR 文件。
- 在计量层之后、进入 Parser 之前，用跨 chunk 的常量大小前缀缓冲检查前两个字节，若为 gzip magic `1f 8b` 则 `ARCHIVE_INVALID`。不足两字节也要在 EOF 处理，不得遗漏首块只有一个字节的情况。
- 因此 `.tar` 内放 gzip、外层 gzip 解开后又是 gzip，均在 Parser 再解压前拒绝，不会通过自动解压绕过完整 TAR 流额度。这是有限 magic 检查，不是格式扫描器。
- 外层 gzip 必须完整结束并通过自身 CRC/长度检查。多 member 的具体兼容行为继承 `node:zlib` 与 Parser；不新增第二份 TAR/尾随结构扫描保证。

## 源请求 path：必须已经规范

仅约束新增解压接口，不修改既有文件 API 的历史路径行为。

- TypeBox schema 为 `Type.String({ minLength: 1, maxLength: 4096 })`，此处按 schema 字符计数，不等价 UTF-8 字节数。
- 服务层要求 UTF-8 总长不超过 4,096 字节、每段不超过 255 字节，超限为 `ARCHIVE_PATH_INVALID`（400），不是输出额度的 413。
- 源字符串必须能原样往返 UTF-8；拒绝未配对 UTF-16 surrogate，避免 Node 文件路径编码替换为 U+FFFD 后命中另一个名称/区域。合法 U+FFFD 本身不拒绝，不执行 Unicode 归一化。
- 必须非空、用 `/` 分隔；不允许前/尾 `/`、重复 `//`、任何空段、`.` 或 `..` 段，不接受再规范化后继续。
- 继续拒绝绝对路径、UNC、Windows 盘符、反斜杠、NUL、CR/LF、冒号及任意 ASCII 大小写形式的 `.git` 段；不 trim 合法前后空格。
- `repo/a.zip` 合法；`./repo/a.zip`、`repo//a.zip`、`repo/./a.zip` 均明确拒绝。**完整字符串验证必须发生在 Workspace/仓库区域选择之前**，防止不同拼写走不同区域锁。
- 响应 `path` 为通过校验的同一规范路径，`dir` 为其父路径，根父目录为 `""`。
- schema 先拒绝时沿用框架校验错误；schema 通过后才由服务返回业务 code。实际 OS 绝对路径长度等更严格限制按 IO 分类处理，不假装 schema 能保证所有 FS 接受。

## 包内路径：解码后的最终有效名称规范化

### 检查顺序

- 先检查公开 entry 类型、尺寸和可观察额度，再检查最终有效名称；结构性根目录也不跳过类型检查和条目计数。
- 拒绝有效名称中的 NUL、CR/LF、反斜杠、绝对路径、UNC、盘符及任何冒号；库自身在回调前拒绝的危险路径同样不能降级接受。
- 按 `/` 分段，在消除 `.` 之前拒绝任何 `..` 段，不能用 `path.normalize` 消除越界意图后接受。
- 与源请求不同，包内允许前导 `./`、内部 `.`、重复 `/`；规范为单 `/` 相对路径，目录去尾斜线。
- 规范化为空的 `.`、`./` 只允许结构性目录声明，计可观察条目数但不输出；同名普通文件或带非零内容目录拒绝。
- 每个有效段 ASCII 大小写不敏感保护 `.git`；合法点文件与 Unicode 保留，不 trim、不做大小写或 NFC/NFD 改写。
- 检查有效名称和规范化输出路径 UTF-8 字节、段长与深度；超额为 `ARCHIVE_LIMIT_EXCEEDED`（413）。实际路径再验证处于本次 payload 内，最终发布再独立校验目标区域。

### 重复、隐式目录与实际 FS 别名

| 情况 | 规则 |
|---|---|
| 先有 `a/b.txt`，再声明 `a/` | 复用本次隐式目录，允许 |
| `./a/`、`a//` 等同一规范路径重复目录 | 合并为一个节点，每次公开声明仍计条目 |
| `a.txt`、`./a.txt` 等重复普通文件 | 整包拒绝，不论内容是否相同 |
| 文件/目录碰撞、文件成为其他项父级 | 整包拒绝，与条目顺序无关 |
| 不同规范字符串在实际 FS 上成为同一节点 | 整包拒绝，不静默覆盖/合并 |
| FS 区分大小写的 `A` 与 `a` | 实际不同则可同时输出 |
| 不区分大小写或 NFC/NFD 别名 FS | 用暂存排他创建和身份登记发现别名；不能只靠 JS Set |

- 清单包含隐式目录；只有相同规范路径的重复目录可复用，另一拼写引发的 `EEXIST` 不是正常重复。
- 目标已有对象/别名仍由实际 FS `lstat` 和排他原语判断，不引入猜测性的全平台 Unicode 折叠算法。

## 初始资源配额与公开计数口径

`MiB = 1024 * 1024`，`GiB = 1024 * MiB`。等于上限允许，超出失败；所有数字要求安全整数，加法防溢出。

| 常量 | 初值 | 计数口径 |
|---|---:|---|
| `MAX_ARCHIVE_INPUT_BYTES` | 512 MiB | 源 fstat.size 和快照实际读取量均检查 |
| `MAX_ARCHIVE_OUTPUT_BYTES` | 2 GiB | 所有普通文件实际输出内容之和 |
| `MAX_ARCHIVE_FILE_BYTES` | 512 MiB | 单文件声明和实际输出分别检查 |
| `MAX_ARCHIVE_NODES` | 20,000 | 去重普通文件及显式/隐式目录；不含结构性根 |
| `MAX_ARCHIVE_RECORDS` | 40,000 | ZIP 公开 entry、TAR 公开 entry/ignoredEntry 事件；重复目录和结构性根每次计数，meta/隐藏物理头不假计 |
| `MAX_ARCHIVE_DEPTH` | 64 | 规范化输出路径段数，含文件名 |
| `MAX_ARCHIVE_PATH_BYTES` | 4,096 | 解码有效名称和规范化输出相对路径 UTF-8 字节 |
| `MAX_ARCHIVE_SEGMENT_BYTES` | 255 | 有效输出段的 UTF-8 字节 |
| `MAX_ARCHIVE_METADATA_RECORD_BYTES` | 64 KiB | TAR maxMetaEntrySize；ZIP 单个名称/extra/comment 的 uint16 声明各至多 65,535 字节，不承诺回调前自定义限额 |
| `MAX_ARCHIVE_METADATA_BYTES` | 8 MiB | 见下述公开可观测口径，不做原始头扫描 |
| `MAX_ARCHIVE_TAR_STREAM_BYTES` | 2 GiB + 64 MiB | 进入 Parser 前完整 TAR 流字节，包括库可能忽略的元数据/填充/尾部 |
| `ARCHIVE_PROCESSING_TIMEOUT_MS` | 120,000 | 取得区域锁后、打开源前开始，涵盖快照/解析/校验/发布 |
| `MAX_ACTIVE_ARCHIVE_OPERATIONS` | 1 / API 进程 | 立即尝试槽位，忙时拒绝，无解压等待队列 |

### 元数据累计与已知缓冲边界

- ZIP 在打开时累计 `zipfile.comment` 的公开字节长度（Buffer 用 length，string 用 UTF-8 编码长度）；每次 entry 加 `entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength`。这些是公开中央目录声明长度，extraFields 的转换不影响这三个长度，不扫描局部头另加一遍。
- ZIP 单 entry 三种变长字段原始总长天然最多 196,605 字节；yauzl 在事件前已有单条有界读取/解码。累计 8 MiB 在公开事件中检查，**不声称所有 ZIP 元数据都能由回调在分配前拒绝**；EOCD comment 也有格式自身的 uint16 上限。
- TAR 用 `maxMetaEntrySize` 在库内部限制单个扩展体声明大小，超限 ignoredEntry 转失败；`meta` 文本按 `Buffer.byteLength(text, "utf8")` 累计，公开 entry 的最终 path UTF-8 字节也累计。解码文本字节口径可能不同于原始元数据字节，这是有意的可观察保守口径。
- Parser 没有公开逐物理 PAX/GNU 头精确计数，不能伪造该指标。隐藏扩展、零填充及 Parser 容忍的其他数据仍受完整 TAR 流字节和处理期限限制。
- 原始输入、实际文件输出、TAR 解码流、公开元数据累计是独立限制；不能只相信声明值，也不能因流式处理就省略其中任何一层。

### IO、磁盘与期限

- 流式并遵循背压，不持有全包/全输出 Buffer。清单内存受节点、路径与公开元数据额度约束。
- 临时峰值约输入快照 + 输出，即约 2.5 GiB 加元数据/目录开销；发布 hardlink 不复制整份数据，也不落中间 TAR。ENOSPC/inode 不足按 IO 失败清理，不自动删除其他文件腾空间。
- 锁等待不计入处理期限；等待中仍占解压槽以防大请求累计，不改造现有锁取消队列。
- 超时为协作中止：停止后续解析/发布、abort/destroy 相关流，等未决 IO 收敛后清理，再释放锁/槽；禁止 Promise.race 返回后继续后台写入。失败无需继续消费恶意包。
- 清理不因处理期限耗尽就跳过；进程崩溃或永久内核 IO 阻塞不在硬实时终止保证内。

## 权限与时间戳

- 暂存根/子目录和发布中新目录以 `0700` 创建，暂存文件以 `0600` 排他创建。
- Unix 普通文件任一正常 execute 位存在时最终规范为 `0755`，其余 `0644`；ZIP 无可靠 Unix mode 按不可执行处理；目录最终 `0755`。
- 不恢复 owner/group、setuid/setgid/sticky、ACL、xattr 或任意组/其他用户写权限，不直接 chmod archive.mode。
- 用受限 chmod 设置最终权限，暂存初始权限不能比设计更宽；正常内部 chmod/link/unlink 引起的身份版本基线更新见[发布与失败协议](04-staging-publication-and-failure.md#所有权版本与本次操作基线)。
- 不恢复归档 atime/mtime，使用本次创建/写入时间。重复目录声明不改变权限策略。
