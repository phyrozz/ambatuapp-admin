import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--port', '3010'], { cwd: new URL('../', import.meta.url), stdio: 'inherit', env: { ...process.env, NEXT_PUBLIC_COGNITO_USER_POOL_ID: 'ap-southeast-1_studiotest', NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID: 'studiotest123', COGNITO_ADMIN_USER_POOL_ID: 'ap-southeast-1_studiotest', FIREBASE_PROJECT_ID: '', FIREBASE_CLIENT_EMAIL: '', FIREBASE_PRIVATE_KEY: '' } });
child.on('exit', code => process.exit(code ?? 0));
