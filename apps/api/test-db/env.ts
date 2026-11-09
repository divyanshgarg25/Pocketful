// Import FIRST in any test that loads app code against the real DB.
import { PGRST_URL, signJwt } from './helpers.js';
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = PGRST_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = await signJwt('service_role');
process.env.SUPABASE_JWT_SECRET = process.env.PGRST_JWT_SECRET ?? 'test-jwt-secret-test-jwt-secret-1234567890';
