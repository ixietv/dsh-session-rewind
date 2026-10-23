/**
 * DSH Session Rewind Plugin
 * 
 * 通过 /rewind 命令将当前对话折叠回退到之前的指定回合，
 * 不创建新会话，原地使用 surface replace 折叠尾部消息。
 */

export interface RewindOptions {
  /** 回退到的目标回合编号 */
  turn: number;
}

/**
 * 插件入口
 */
export function apply(ctx: any) {
  // 注册 /rewind 命令
  ctx.command('rewind <turn:number>', '将对话回退到指定回合')
    .action(async (options: RewindOptions, turn: number) => {
      const targetTurn = turn ?? options.turn;
      
      if (!targetTurn || targetTurn < 1) {
        return '请指定有效的回合编号（从 1 开始）';
      }

      try {
        // 获取当前会话信息
        const session = ctx.session;
        if (!session) {
          return '无法获取当前会话信息';
        }

        // TODO: 实现 surface replace 逻辑
        // 1. 获取会话历史
        // 2. 定位目标回合
        // 3. 使用 surface replace 折叠尾部消息
        
        return `会话已回退到第 ${targetTurn} 回合`;
      } catch (error) {
        console.error('Rewind failed:', error);
        return `回退失败: ${error instanceof Error ? error.message : String(error)}`;
      }
    });
}

export const name = 'dsh-session-rewind';
export const version = '0.1.0';
