/**
 * Users for trying the provider out: testuser and otheruser, both with the
 * password "password". Never register them in production.
 *
 * registerDevelopmentUsers() puts them into the database of db/ with
 * registerUser(), the same way an application registers its own users, so
 * the login form accepts them whichever database the provider is generated
 * with.
 */
import type { UserClaims } from '@maronn-openid-connect/core';
import { createProviderStores, registerUser, type Database } from './db/index.js';

export const developmentUsers: readonly (UserClaims & { password: string })[] = [
  {
    // Carries the standard claims for every scope advertised in Discovery
    // (profile / email / address / phone — OIDC Core 1.0 §5.4) so the OIDF
    // Conformance Suite's VerifyScopesReturnedInUserInfoClaims finds a value for
    // each requested scope. filterClaimsByScope still gates what is returned per
    // scope; populating the fixture is the resolver's responsibility.
    sub: 'testuser',
    // profile scope
    name: 'Test User',
    family_name: 'User',
    given_name: 'Test',
    middle_name: 'Q',
    nickname: 'testy',
    preferred_username: 'testuser',
    profile: 'https://op.example.com/users/testuser',
    picture: 'https://op.example.com/users/testuser/avatar.png',
    website: 'https://testuser.example.com',
    gender: 'unspecified',
    birthdate: '1990-01-01',
    zoneinfo: 'Asia/Tokyo',
    locale: 'en-US',
    updated_at: 1700000000,
    // email scope
    email: 'test@example.com',
    email_verified: true,
    // address scope
    address: {
      formatted: '100 Test Street, Test City, TS 10000, JP',
      street_address: '100 Test Street',
      locality: 'Test City',
      region: 'TS',
      postal_code: '10000',
      country: 'JP',
    },
    // phone scope
    phone_number: '+81-3-0000-0000',
    phone_number_verified: true,
    password: 'password',
  },
  {
    // A second user makes subject-isolation and id_token_hint / session
    // mismatch flows reproducible with real signed tokens.
    sub: 'otheruser',
    name: 'Other User',
    preferred_username: 'otheruser',
    email: 'other@example.com',
    email_verified: true,
    password: 'password',
  },
];

/**
 * Register the development users that are not registered yet. registerUser()
 * hashes the password with PBKDF2, which costs CPU time, so a user that is
 * already there is left as it is.
 */
export async function registerDevelopmentUsers(db: Database): Promise<void> {
  const { userStore } = createProviderStores(db);
  for (const user of developmentUsers) {
    if (await userStore.getClaims(user.sub)) continue;
    await registerUser(db, user);
  }
}
