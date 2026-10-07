import { Dataset, VerificationResult, ProofNumber } from '../types/analyst';

export function runSandboxedVerification(
  code: string,
  dataset: Dataset,
  expectedProofNumbers: ProofNumber[] = []
): VerificationResult {
  const startTime = performance.now();
  const stdoutLogs: string[] = [];
  let computedOutputs: Record<string, any> = {};
  let errorMsg: string | undefined;

  // Build table map for sandbox
  const tableData: Record<string, any[]> = {};
  for (const table of dataset.tables) {
    tableData[table.id] = JSON.parse(JSON.stringify(table.rows));
  }

  // Intercept console.log
  const customConsole = {
    log: (...args: any[]) => {
      const line = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
      stdoutLogs.push(line);
    },
    warn: (...args: any[]) => {
      stdoutLogs.push(`[WARN] ` + args.map(a => String(a)).join(' '));
    },
    error: (...args: any[]) => {
      stdoutLogs.push(`[ERROR] ` + args.map(a => String(a)).join(' '));
    }
  };

  try {
    // Construct isolated function execution
    // Exposes tables directly as variables and dataset object
    const tableKeys = Object.keys(tableData);
    const tableValues = Object.values(tableData);

    // Notice: let output is explicitly declared so scripts writing "output = { ... }" succeed
    const wrappedCode = `
      var output = undefined;
      var results = {};
      var log = console.log;
      ${code}
      if (typeof output !== 'undefined' && output !== null) {
        return output;
      }
      if (typeof results !== 'undefined' && results !== null && Object.keys(results).length > 0) {
        return results;
      }
      return {};
    `;

    const runner = new Function(
      'dataset',
      'console',
      ...tableKeys,
      wrappedCode
    );

    const execResult = runner(
      tableData,
      customConsole,
      ...tableValues
    );

    if (execResult && typeof execResult === 'object') {
      computedOutputs = execResult;
    } else if (execResult !== undefined) {
      computedOutputs = { result: execResult };
    }
  } catch (err: any) {
    errorMsg = err?.message || String(err);
    stdoutLogs.push(`Execution Failed: ${errorMsg}`);
  }

  const runtimeMs = Math.round((performance.now() - startTime) * 100) / 100;

  // Verify proof numbers against computed outputs or stdout
  let allNumbersMatch = true;
  const verifiedProofNumbers: ProofNumber[] = expectedProofNumbers.map((expected) => {
    let computedVal: any = undefined;

    // 1. Direct key match in computedOutputs
    if (expected.codeVariable && computedOutputs[expected.codeVariable] !== undefined) {
      computedVal = computedOutputs[expected.codeVariable];
    } else {
      // Case-insensitive match on codeVariable
      const targetVarLower = (expected.codeVariable || '').toLowerCase().trim();
      const targetLabelLower = (expected.label || '').toLowerCase().trim();

      for (const [key, val] of Object.entries(computedOutputs)) {
        const keyLower = key.toLowerCase().trim();
        if (keyLower === targetVarLower || keyLower === targetLabelLower) {
          computedVal = val;
          break;
        }
      }

      // Substring match if still not found
      if (computedVal === undefined && targetVarLower) {
        for (const [key, val] of Object.entries(computedOutputs)) {
          const keyLower = key.toLowerCase().trim();
          if (keyLower.includes(targetVarLower) || targetVarLower.includes(keyLower)) {
            computedVal = val;
            break;
          }
        }
      }
    }

    // 2. If still undefined, scan stdout logs for variable assignments or values
    if (computedVal === undefined && expected.codeVariable) {
      const varName = expected.codeVariable;
      const patterns = [
        new RegExp(`${varName}\\s*[:=]\\s*([\\d\\.\\-]+)`, 'i'),
        new RegExp(`${expected.label}\\s*[:=]\\s*([\\d\\.\\-]+)`, 'i'),
        new RegExp(`Total[^:]*[:=]\\s*([\\d\\.\\-]+)`, 'i')
      ];

      for (const pattern of patterns) {
        for (const line of stdoutLogs) {
          const match = line.match(pattern);
          if (match && match[1]) {
            computedVal = parseFloat(match[1]);
            break;
          }
        }
        if (computedVal !== undefined) break;
      }
    }

    // 3. Fallback: if only one number in computedOutputs and one expected
    if (computedVal === undefined && expectedProofNumbers.length === 1 && Object.keys(computedOutputs).length > 0) {
      computedVal = Object.values(computedOutputs)[0];
    }

    // Comparison logic
    let matchStatus: 'verified' | 'mismatch' | 'refused' = 'mismatch';
    if (computedVal !== undefined) {
      const expectedNum = typeof expected.value === 'number' ? expected.value : parseFloat(String(expected.value));
      const computedNum = typeof computedVal === 'number' ? computedVal : parseFloat(String(computedVal));

      if (!isNaN(expectedNum) && !isNaN(computedNum)) {
        const tolerance = expected.tolerance || 0.05;
        if (Math.abs(expectedNum - computedNum) <= tolerance) {
          matchStatus = expected.matchStatus === 'refused' ? 'refused' : 'verified';
        } else {
          matchStatus = 'mismatch';
          allNumbersMatch = false;
        }
      } else if (String(expected.value).trim().toLowerCase() === String(computedVal).trim().toLowerCase()) {
        matchStatus = expected.matchStatus === 'refused' ? 'refused' : 'verified';
      } else {
        matchStatus = 'mismatch';
        allNumbersMatch = false;
      }
    } else {
      matchStatus = 'mismatch';
      allNumbersMatch = false;
    }

    return {
      ...expected,
      computedValue: computedVal !== undefined ? computedVal : 'NOT_FOUND',
      matchStatus
    };
  });

  // Simple deterministic hash
  const signatureInput = `${dataset.id}:${code}:${JSON.stringify(computedOutputs)}:${allNumbersMatch}`;
  let hashNum = 0;
  for (let i = 0; i < signatureInput.length; i++) {
    hashNum = ((hashNum << 5) - hashNum) + signatureInput.charCodeAt(i);
    hashNum |= 0;
  }
  const hash = '0x' + Math.abs(hashNum).toString(16).padStart(8, '0');

  return {
    ranSuccessfully: !errorMsg,
    runtimeMs,
    stdout: stdoutLogs,
    computedOutputs,
    proofNumbers: verifiedProofNumbers,
    allNumbersMatch: !errorMsg && (expectedProofNumbers.length === 0 || allNumbersMatch),
    hash,
    error: errorMsg
  };
}
