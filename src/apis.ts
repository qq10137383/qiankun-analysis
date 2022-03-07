import { noop } from 'lodash';
import type { ParcelConfigObject } from 'single-spa';
import { mountRootParcel, registerApplication, start as startSingleSpa } from 'single-spa';
import type { ObjectType } from './interfaces';
import type { FrameworkConfiguration, FrameworkLifeCycles, LoadableApp, MicroApp, RegistrableApp } from './interfaces';
import type { ParcelConfigObjectGetter } from './loader';
import { loadApp } from './loader';
import { doPrefetchStrategy } from './prefetch';
import { Deferred, getContainer, getXPathForElement, toArray } from './utils';

// 已注册的微应用
let microApps: Array<RegistrableApp<Record<string, unknown>>> = [];

// eslint-disable-next-line import/no-mutable-exports
export let frameworkConfiguration: FrameworkConfiguration = {};

// 乾坤是否已启动
let started = false;
const defaultUrlRerouteOnly = true;

// 信号标志，用来同步乾坤启动信号(Deferred是Promise的包装)
const frameworkStartedDefer = new Deferred<void>();

// 注册微前端应用
export function registerMicroApps<T extends ObjectType>(
  apps: Array<RegistrableApp<T>>,
  lifeCycles?: FrameworkLifeCycles<T>,
) {
  // Each app only needs to be registered once
  // 过滤出未注册的微应用，已经注册的不用再注册
  const unregisteredApps = apps.filter((app) => !microApps.some((registeredApp) => registeredApp.name === app.name));

  // 更新已注册的微应用列表，加入需要注册的微应用
  microApps = [...microApps, ...unregisteredApps];

  // 遍历未注册的微应用注册
  unregisteredApps.forEach((app) => {
    const { name, activeRule, loader = noop, props, ...appConfig } = app;

    // 调用single-spa的微应用注册方法
    registerApplication({
      name,
      // 对single-spa的微应用加载函数进行包装，加入隔离沙箱的初始化等功能
      app: async () => {
        // 加载微应用前，给一个外部回调机会，设置标准为加载前(true)
        loader(true);
        // 等待乾坤启动信号，调用start()方法启动后，frameworkStartedDefer.resolve()，这时候才会进行微应用加载
        await frameworkStartedDefer.promise;

        const { mount, ...otherMicroAppConfigs } = (
          // 加载微应用，并包装微应用生命周期函数(沙盒启动卸载，生命周期钩子等)
          await loadApp({ name, props, ...appConfig }, frameworkConfiguration, lifeCycles)
        )();
        
        // 返回包装后的生命周期函数给single-spa
        return {
          mount: [async () => loader(true), ...toArray(mount), async () => loader(false)],
          ...otherMicroAppConfigs,
        };
      },
      activeWhen: activeRule,
      customProps: props,
    });
  });
}

const appConfigPromiseGetterMap = new Map<string, Promise<ParcelConfigObjectGetter>>();
// parcel列表
const containerMicroAppsMap = new Map<string, MicroApp[]>();

// 手动启动微应用
export function loadMicroApp<T extends ObjectType>(
  app: LoadableApp<T>,
  configuration?: FrameworkConfiguration,
  lifeCycles?: FrameworkLifeCycles<T>,
): MicroApp {
  const { props, name } = app;

  const getContainerXpath = (container: string | HTMLElement): string | void => {
    const containerElement = getContainer(container);
    if (containerElement) {
      return getXPathForElement(containerElement, document);
    }

    return undefined;
  };

  let microApp: MicroApp; // parcel实例
  const wrapParcelConfigForRemount = (config: ParcelConfigObject): ParcelConfigObject => {
    const container = 'container' in app ? app.container : undefined;

    let microAppConfig = config;
    if (container) {
      const xpath = getContainerXpath(container);
      if (xpath) {
        const containerMicroApps = containerMicroAppsMap.get(`${name}-${xpath}`);
        if (containerMicroApps?.length) {
          const mount = [
            async () => {
              // While there are multiple micro apps mounted on the same container, we must wait until the prev instances all had unmounted
              // Otherwise it will lead some concurrent issues
              const prevLoadMicroApps = containerMicroApps.slice(0, containerMicroApps.indexOf(microApp));
              const prevLoadMicroAppsWhichNotBroken = prevLoadMicroApps.filter(
                (v) => v.getStatus() !== 'LOAD_ERROR' && v.getStatus() !== 'SKIP_BECAUSE_BROKEN',
              );
              await Promise.all(prevLoadMicroAppsWhichNotBroken.map((v) => v.unmountPromise));
            },
            ...toArray(microAppConfig.mount),
          ];

          microAppConfig = {
            ...config,
            mount,
          };
        }
      }
    }

    return {
      ...microAppConfig,
      // empty bootstrap hook which should not run twice while it calling from cached micro app
      bootstrap: () => Promise.resolve(),
    };
  };

  /**
   * using name + container xpath as the micro app instance id,
   * it means if you rendering a micro app to a dom which have been rendered before,
   * the micro app would not load and evaluate its lifecycles again
   * 包装parcel配置信息，增加异步加载，沙箱启动、卸载，声明周期钩子拦截等功能
   */
  const memorizedLoadingFn = async (): Promise<ParcelConfigObject> => {
    const userConfiguration = configuration ?? { ...frameworkConfiguration, singular: false };
    const { $$cacheLifecycleByAppName } = userConfiguration;
    const container = 'container' in app ? app.container : undefined;

    // 获取parcel挂载的dom容器
    if (container) {
      // using appName as cache for internal experimental scenario
      if ($$cacheLifecycleByAppName) {
        const parcelConfigGetterPromise = appConfigPromiseGetterMap.get(name);
        if (parcelConfigGetterPromise) return wrapParcelConfigForRemount((await parcelConfigGetterPromise)(container));
      }

      const xpath = getContainerXpath(container);
      if (xpath) {
        const parcelConfigGetterPromise = appConfigPromiseGetterMap.get(`${name}-${xpath}`);
        if (parcelConfigGetterPromise) return wrapParcelConfigForRemount((await parcelConfigGetterPromise)(container));
      }
    }

    // 加载parcel信息，这里与registerMicroApps加载微应用app信息的方法相同，都是包装微应用生命周期函数(沙盒启动卸载，生命周期钩子等)
    // parcel其实与app功能大致是类似的，不过从逻辑上parcel可以作为app的子应用
    const parcelConfigObjectGetterPromise = loadApp(app, userConfiguration, lifeCycles);

    if (container) {
      if ($$cacheLifecycleByAppName) {
        appConfigPromiseGetterMap.set(name, parcelConfigObjectGetterPromise);
      } else {
        const xpath = getContainerXpath(container);
        if (xpath) appConfigPromiseGetterMap.set(`${name}-${xpath}`, parcelConfigObjectGetterPromise);
      }
    }

    return (await parcelConfigObjectGetterPromise)(container);
  };

  // single-spa未启动，就自动启动
  if (!started) {
    // We need to invoke start method of single-spa as the popstate event should be dispatched while the main app calling pushState/replaceState automatically,
    // but in single-spa it will check the start status before it dispatch popstate
    // see https://github.com/single-spa/single-spa/blob/f28b5963be1484583a072c8145ac0b5a28d91235/src/navigation/navigation-events.js#L101
    // ref https://github.com/umijs/qiankun/pull/1071
    startSingleSpa({ urlRerouteOnly: frameworkConfiguration.urlRerouteOnly ?? defaultUrlRerouteOnly });
  }

  // 手动启动的微应用是通过single-spa的mountRootParcel启动的，说明parcel是独立存在的，不属于任何微应用，这就决定了
  // 手动启动的微应用需要手动卸载(microApp.unmount)
  microApp = mountRootParcel(memorizedLoadingFn, { domElement: document.createElement('div'), ...props });

  // Store the microApps which they mounted on the same container
  const container = 'container' in app ? app.container : undefined;
  if (container) {
    const xpath = getContainerXpath(container);
    if (xpath) {
      const key = `${name}-${xpath}`;

      const microAppsRef = containerMicroAppsMap.get(key) || [];
      microAppsRef.push(microApp);
      containerMicroAppsMap.set(key, microAppsRef);

      const cleanApp = () => {
        const index = microAppsRef.indexOf(microApp);
        microAppsRef.splice(index, 1);
        // @ts-ignore
        microApp = null;
      };

      // gc after unmount
      // parcel卸载时从parcel列表中清除，释放引用
      microApp.unmountPromise.then(cleanApp).catch(cleanApp);
    }
  }

  return microApp;
}

export function start(opts: FrameworkConfiguration = {}) {
  frameworkConfiguration = { prefetch: true, singular: true, sandbox: true, ...opts };
  const {
    prefetch,
    sandbox,
    singular,
    urlRerouteOnly = defaultUrlRerouteOnly,
    ...importEntryOpts
  } = frameworkConfiguration;

  // 预加载设置,single-spa仅仅会在未调用start()，但是有微应用需要激活时才会去预加载此微应用
  // 等start调用后就直接启动激活，qiankun做了改进增加了提取预初始化任何微应用
  if (prefetch) {
    doPrefetchStrategy(microApps, prefetch, importEntryOpts);
  }

  // 沙盒的类型判断，浏览器是否支持
  if (sandbox) {
    if (!window.Proxy) {
      console.warn('[qiankun] Miss window.Proxy, proxySandbox will degenerate into snapshotSandbox');
      frameworkConfiguration.sandbox = typeof sandbox === 'object' ? { ...sandbox, loose: true } : { loose: true };
      // 对于多实例微应用，沙盒必须使用ProxySandbox支持多实例，ProxySanbox是基于Proxy实现的，所有需要浏览器支持Proxy
      if (!singular) {
        console.warn(
          '[qiankun] Setting singular as false may cause unexpected behavior while your browser not support window.Proxy',
        );
      }
    }
  }

  // 调用single-spa的启动方法
  startSingleSpa({ urlRerouteOnly });
  started = true;

  frameworkStartedDefer.resolve();
}
