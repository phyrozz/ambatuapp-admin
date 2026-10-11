import type { NextConfig } from 'next';
const nextConfig: NextConfig = {
  async headers() {
    return [{
      source: '/api/public/contributions/:path*',
      headers: [
        { key: 'Access-Control-Allow-Origin', value: '*' },
        { key: 'Access-Control-Allow-Headers', value: 'content-type, authorization' },
        { key: 'Access-Control-Allow-Methods', value: 'GET, POST, PATCH, DELETE, OPTIONS' },
      ],
    }];
  },
};
export default nextConfig;
