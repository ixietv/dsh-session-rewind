# dsh-session-rewind

DSH 会话回退插件 - 通过 /rewind 命令将当前对话折叠回退到之前的指定回合

## 功能特性

- 🔙 使用 `/rewind <回合数>` 命令回退会话
- 📦 不创建新会话，原地使用 surface replace 折叠尾部消息
- ⚡ 轻量级，无额外依赖

## 安装

```bash
# 在 DSH Desktop 中通过插件管理器安装
# 或手动克隆到插件目录
git clone https://github.com/ixietv/dsh-session-rewind.git
```

## 使用方法

```bash
# 回退到第 5 回合
/rewind 5

# 查看当前会话信息
/rewind info
```

## 开发

```bash
# 安装依赖
npm install

# 构建
npm run build

# 运行测试
npm test

# 开发模式
npm run dev
```

## 项目结构

```
dsh-session-rewind/
├── src/
│   └── index.ts          # 插件入口
├── test/
│   └── index.test.ts     # 测试文件
├── package.json
├── tsconfig.json
├── dsh.plugin.json       # DSH 插件配置
└── README.md
```

## 许可证

MIT

## 相关链接

- [DSH Desktop](https://github.com/DeepSeek-DSH/dsh-desktop)
- [DSH 插件开发文档](https://github.com/DeepSeek-DSH/dsh-desktop/wiki/Plugin-Development)
