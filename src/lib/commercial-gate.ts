/**
 * Commercial Launch Gate
 * 
 * Enforces ADR-040 §5 and §6 requirements.
 * 
 * Requirements:
 * 1. LLC + Accountant must be engaged.
 * 2. Counsel must draft BUSL re-scope (ADR-040 §5).
 * 3. Merchant-of-Record (MoR) infrastructure must be configured.
 * 
 * This module prevents execution of payment/issuance logic until the 
 * COMMERCIAL_LAUNCH_ENABLED flag is explicitly set to 'true' in the 
 * environment, verified by the legal team.
 */

export class CommercialLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommercialLaunchError';
  }
}

export interface LaunchConfig {
  isCommercialEnabled: boolean;
  legalDraftStatus: 'pending' | 'drafted' | 'approved';
  moRProvider: 'stripe' | 'paddle' | 'none';
  accountantEngaged: boolean;
}

// Default configuration reflecting pre-launch state (Blocked)
const DEFAULT_CONFIG: LaunchConfig = {
  isCommercialEnabled: false,
  legalDraftStatus: 'pending',
  moRProvider: 'none',
  accountantEngaged: false,
};

/**
 * Retrieves the current commercial launch configuration.
 * Reads from environment variables.
 */
export function getCommercialConfig(): LaunchConfig {
  const env = process.env;
  
  // Check for explicit override (set by legal/ops only)
  const enabledFlag = env.COMMERCIAL_LAUNCH_ENABLED?.toLowerCase() === 'true';
  
  // Parse other status flags
  const legalStatus = (env.LEGAL_DRAFT_STATUS as LaunchConfig['legalDraftStatus']) || 'pending';
  const moRProvider = (env.MOR_PROVIDER as LaunchConfig['moRProvider']) || 'none';
  const accountant = env.ACCOUNTANT_ENGAGED?.toLowerCase() === 'true';

  return {
    isCommercialEnabled: enabledFlag,
    legalDraftStatus: legalStatus,
    moRProvider: moRProvider,
    accountantEngaged: accountant,
  };
}

/**
 * Validates if the system is ready for commercial operations.
 * Throws an error if the gate is closed.
 */
export function assertCommercialLaunchReady(): void {
  const config = getCommercialConfig();

  if (!config.isCommercialEnabled) {
    throw new CommercialLaunchError(
      'Commercial launch is blocked. ' +
      'Environment variable COMMERCIAL_LAUNCH_ENABLED must be set to "true". ' +
      'Ensure ADR-040 §5 (Counsel Draft) and LLC/Accountant requirements are met.'
    );
  }

  if (config.legalDraftStatus !== 'approved') {
    throw new CommercialLaunchError(
      'Legal draft status is not approved. ' +
      'Current status: ' + config.legalDraftStatus + '. ' +
      'Cannot proceed with payment processing.'
    );
  }

  if (!config.accountantEngaged) {
    throw new CommercialLaunchError(
      'Accountant engagement is missing. ' +
      'Set ACCOUNTANT_ENGAGED=true before taking money.'
    );
  }

  if (config.moRProvider === 'none') {
    throw new CommercialLaunchError(
      'No Merchant-of-Record provider configured. ' +
      'Set MOR_PROVIDER to "stripe" or "paddle".'
    );
  }
}

/**
 * Wrapper for payment processing functions to ensure the gate is open.
 * Use this instead of calling payment logic directly.
 */
export async function withCommercialGate<T>(
  operation: () => Promise<T>
): Promise<T> {
  assertCommercialLaunchReady();
  return operation();
}