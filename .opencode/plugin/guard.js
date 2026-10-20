import { check, normalize } from '../../.agents/hooks/core.mjs';

export const Guard = async () => ({
  'tool.execute.before': async (input, output) => {
    const reason = check(normalize({ tool_input: output.args }));
    if (reason) throw new Error(reason);
  },
});
