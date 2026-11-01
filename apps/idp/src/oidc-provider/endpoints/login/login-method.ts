/**
 * A way to sign in that a feature adds to the login page, next to the
 * password form (the loginMethods hook of features/feature.ts).
 *
 * The login page asks every method to render itself for the transaction it
 * shows, and places what comes back below the form. The method serves the
 * rest of its sign-in itself, on a route of its own feature.
 */
import type { AuthTransaction } from '@maronn-openid-connect/core';
import type { ViewResult } from '../../views.js';

export interface LoginMethod {
  /** A name for the method, such as 'google'. */
  readonly id: string;
  /**
   * What the login page shows for the method, for this transaction; undefined
   * to show nothing (the method is not configured).
   */
  render(
    c: any,
    input: { transactionId: string; transaction: AuthTransaction },
  ): Promise<ViewResult | undefined>;
}
