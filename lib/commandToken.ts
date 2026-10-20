/**
 * 명령행 문자열 토크나이저 (lib/commandToken.ts)
 * - 공백으로 토큰 구분
 * - 큰따옴표(") 및 작은따옴표(') 묶음 지원
 * - --app="삼성 인터넷", --app='삼성 인터넷', "--app=삼성 인터넷" 모두 ["--app=삼성 인터넷"]으로 동일하게 토큰화
 * - 따옴표 내부 이스케이프(\", \', \\) 지원
 * - 닫히지 않은 따옴표는 Error throw
 */

export function tokenizeCommandLine(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote: '"' | "'" | null = null;
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (inQuote) {
      if (ch === "\\") {
        if (i + 1 < input.length) {
          const next = input[i + 1];
          if (next === inQuote || next === "\\") {
            current += next;
            i += 2;
            continue;
          }
        }
        current += ch;
        i++;
      } else if (ch === inQuote) {
        inQuote = null;
        i++;
      } else {
        current += ch;
        i++;
      }
    } else {
      if (ch === '"' || ch === "'") {
        inQuote = ch;
        i++;
      } else if (/\s/.test(ch)) {
        if (current.length > 0) {
          tokens.push(current);
          current = "";
        }
        i++;
      } else {
        current += ch;
        i++;
      }
    }
  }

  if (inQuote) {
    throw new Error(`닫히지 않은 따옴표(${inQuote})가 있습니다`);
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}
