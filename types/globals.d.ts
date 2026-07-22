// Ambient type augmentations for the plain-JS backend (used by checkJs).
import 'express';

declare global {
  namespace Express {
    interface Request {
      /** short per-request id for correlating log lines */
      id?: string;
      /** anonymous analytics id (from the uv_anon cookie) */
      anon?: string;
      /** authenticated student, attached by requireAuth */
      student?: any;
      /** authenticated admin, attached by requireAdmin */
      admin?: any;
      /** authenticated university-partner account, attached by requireUni */
      uniAccount?: any;
      /** memoised parsed cookies */
      _cookies?: Record<string, string>;
    }
  }
}

export {};
