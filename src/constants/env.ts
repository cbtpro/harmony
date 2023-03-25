// @ts-ignore
export const env = import.meta.env.VITE_ENV;

/** 是开发环境 */
export const isDev = env === 'dev';
/** 是测试环境 */
export const isTest = env === 'test';
/** 是生产环境 */
export const isProd = env === 'prod';