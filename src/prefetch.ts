/**
 * @author Kuitos
 * @since 2019-02-26
 */

import type { Entry, ImportEntryOpts } from 'import-html-entry';
import { importEntry } from 'import-html-entry';
import { isFunction } from 'lodash';
import { getAppStatus, getMountedApps, NOT_LOADED } from 'single-spa';
import type { AppMetadata, PrefetchStrategy } from './interfaces';

type RequestIdleCallbackHandle = any;
type RequestIdleCallbackOptions = {
  timeout: number;
};
type RequestIdleCallbackDeadline = {
  readonly didTimeout: boolean;
  timeRemaining: () => number;
};

// 声明全局模块，在window对象上重写2个接口requestIdleCallback，cancelIdleCallback
declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Window {
    // 浏览器闲散时间请求回调
    requestIdleCallback: (
      callback: (deadline: RequestIdleCallbackDeadline) => void,
      opts?: RequestIdleCallbackOptions,
    ) => RequestIdleCallbackHandle;
    // 回调取消
    cancelIdleCallback: (handle: RequestIdleCallbackHandle) => void;
  }

  // 重写navigator对象的connection属性
  interface Navigator {
    connection: {
      saveData: boolean;
      effectiveType: string;
      type: 'bluetooth' | 'cellular' | 'ethernet' | 'none' | 'wifi' | 'wimax' | 'other' | 'unknown';
    };
  }
}

// RIC and shim for browsers setTimeout() without it
// window.requestIdleCallback的垫片，利用浏览器闲散时间执行回调
const requestIdleCallback =
  window.requestIdleCallback ||
  function requestIdleCallback(cb: CallableFunction) {
    const start = Date.now();
    return setTimeout(() => {
      cb({
        didTimeout: false,
        timeRemaining() {
          return Math.max(0, 50 - (Date.now() - start));
        },
      });
    }, 1);
  };

const isSlowNetwork = navigator.connection
  ? navigator.connection.saveData ||
    (navigator.connection.type !== 'wifi' &&
      navigator.connection.type !== 'ethernet' &&
      /(2|3)g/.test(navigator.connection.effectiveType))
  : false;

/**
 * prefetch assets, do nothing while in mobile network
 * 预初始化微应用，
 * @param entry
 * @param opts
 */
function prefetch(entry: Entry, opts?: ImportEntryOpts): void {
  if (!navigator.onLine || isSlowNetwork) {
    // Don't prefetch if in a slow network or offline
    return;
  }

  // 1、import-html-entry下载微应用，解析出外部脚本(script)和样式(link)，2、预下载外部脚本样式
  // 因为import-html-entry的内部实现对scripts和link做了缓存处理，所以下次调用importEntry不会重新下载
  requestIdleCallback(async () => {
    const { getExternalScripts, getExternalStyleSheets } = await importEntry(entry, opts);
    requestIdleCallback(getExternalStyleSheets);
    requestIdleCallback(getExternalScripts);
  });
}

// 第一个微应用mount之后执行微应用预加载
function prefetchAfterFirstMounted(apps: AppMetadata[], opts?: ImportEntryOpts): void {
  window.addEventListener('single-spa:first-mount', function listener() {
    // 调用single-spa的方法获取没有加载的app，并过滤出此次需要预加载的app
    const notLoadedApps = apps.filter((app) => getAppStatus(app.name) === NOT_LOADED);

    if (process.env.NODE_ENV === 'development') {
      const mountedApps = getMountedApps();
      console.log(`[qiankun] prefetch starting after ${mountedApps} mounted...`, notLoadedApps);
    }

    // 执行预加载
    notLoadedApps.forEach(({ entry }) => prefetch(entry, opts));

    window.removeEventListener('single-spa:first-mount', listener);
  });
}

// 立即执行预加载
export function prefetchImmediately(apps: AppMetadata[], opts?: ImportEntryOpts): void {
  if (process.env.NODE_ENV === 'development') {
    console.log('[qiankun] prefetch starting for apps...', apps);
  }

  apps.forEach(({ entry }) => prefetch(entry, opts));
}

// 解析预加载策略
export function doPrefetchStrategy(
  apps: AppMetadata[],
  prefetchStrategy: PrefetchStrategy,
  importEntryOpts?: ImportEntryOpts,
) {
  // 过滤出需要预加载的app
  const appsName2Apps = (names: string[]): AppMetadata[] => apps.filter((app) => names.includes(app.name));

  // 预加载的是数组的情况，就是需要预加载指定的app，这些app会在第一个微应用mount之后执行预加载
  if (Array.isArray(prefetchStrategy)) {
    prefetchAfterFirstMounted(appsName2Apps(prefetchStrategy as string[]), importEntryOpts);
  } else if (isFunction(prefetchStrategy)) {
    (async () => {
      // critical rendering apps would be prefetch as earlier as possible
      const { criticalAppNames = [], minorAppsName = [] } = await prefetchStrategy(apps);
      prefetchImmediately(appsName2Apps(criticalAppNames), importEntryOpts);
      prefetchAfterFirstMounted(appsName2Apps(minorAppsName), importEntryOpts);
    })();
  } else {
    switch (prefetchStrategy) {
      case true:
        prefetchAfterFirstMounted(apps, importEntryOpts);
        break;

      case 'all':
        prefetchImmediately(apps, importEntryOpts);
        break;

      default:
        break;
    }
  }
}
