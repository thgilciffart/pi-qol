export interface ExportOptions { filename: string; conversation: boolean; redact: boolean; literals: string[] }

export function parseOptions(args: string): ExportOptions {
  const tokens: string[] = [];
  let token = '', quote = '', started = false;
  // Quotes group spaces; backslashes remain literal for Windows paths and LaTeX.
  for (const char of args) {
    if (quote) { if (char === quote) quote = ''; else token += char; started = true; }
    else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) tokens.push(token); token = ''; started = false; }
    else { token += char; started = true; }
  }
  if (quote) throw new Error('Unclosed quote in export arguments.');
  if (started) tokens.push(token);
  const options: ExportOptions = { filename: '', conversation: false, redact: false, literals: [] };
  let pathsOnly = false;
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const value = tokens[i];
    if (!pathsOnly && value === '--') pathsOnly = true;
    else if (!pathsOnly && value === '--conversation') options.conversation = true;
    else if (!pathsOnly && value === '--redact') options.redact = true;
    else if (!pathsOnly && value === '--share') { options.conversation = true; options.redact = true; }
    else if (!pathsOnly && value === '--redact-text') {
      const literal = tokens[++i];
      if (!literal || literal.startsWith('--')) throw new Error('--redact-text needs a non-empty quoted value.');
      options.literals.push(literal); options.redact = true;
    } else if (!pathsOnly && value.startsWith('--')) throw new Error(`Unknown export option: ${value}`);
    else paths.push(value);
  }
  options.filename = paths.join(' ');
  return options;
}
