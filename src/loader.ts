/**
 * @author Kuitos
 * @since 2020-04-01
 */

import { importEntry } from 'import-html-entry';
import { concat, forEach, mergeWith } from 'lodash';
import type { LifeCycles, ParcelConfigObject } from 'single-spa';
import getAddOns from './addons';
import { QiankunError } from './error';
import { getMicroAppStateActions } from './globalState';
import type {
  FrameworkConfiguration,
  FrameworkLifeCycles,
  HTMLContentRender,
  LifeCycleFn,
  LoadableApp,
  ObjectType,
} from './interfaces';
import { createSandboxContainer, css } from './sandbox';
import {
  Deferred,
  getContainer,
  getDefaultTplWrapper,
  getWrapperId,
  isEnableScopedCSS,
  performanceMark,
  performanceMeasure,
  performanceGetEntriesByName,
  toArray,
  validateExportLifecycle,
} from './utils';

function assertElementExist(element: Element | null | undefined, msg?: string) {
  if (!element) {
    if (msg) {
      throw new QiankunError(msg);
    }

    throw new QiankunError('element not existed!');
  }
}

// 顺序执行生命周期钩子函数，等上一个执行完成，再执行下一个
function execHooksChain<T extends ObjectType>(
  hooks: Array<LifeCycleFn<T>>,
  app: LoadableApp<T>,
  global = window,
): Promise<any> {
  if (hooks.length) {
    return hooks.reduce((chain, hook) => chain.then(() => hook(app, global)), Promise.resolve());
  }

  return Promise.resolve();
}

async function validateSingularMode<T extends ObjectType>(
  validate: FrameworkConfiguration['singular'],
  app: LoadableApp<T>,
): Promise<boolean> {
  return typeof validate === 'function' ? validate(app) : !!validate;
}

// 浏览器是否支持ShadowDOM
// @ts-ignore
const supportShadowDOM = document.head.attachShadow || document.head.createShadowRoot;

// 创建微应用dom
function createElement(
  appContent: string, // import-html-entry加载的模板template
  strictStyleIsolation: boolean, // 是否启用严格样式隔离
  scopedCSS: boolean, // 使用启用作用域样式隔离
  appName: string, // 微应用名
): HTMLElement {
  const containerElement = document.createElement('div');
  containerElement.innerHTML = appContent;
  // appContent always wrapped with a singular div
  const appElement = containerElement.firstChild as HTMLElement;
  if (strictStyleIsolation) {
    if (!supportShadowDOM) {
      console.warn(
        '[qiankun]: As current browser not support shadow dom, your strictStyleIsolation configuration will be ignored!',
      );
    } else {
      const { innerHTML } = appElement;
      appElement.innerHTML = '';
      let shadow: ShadowRoot;

      // 严格样式隔离模式下创建ShadowDOM
      if (appElement.attachShadow) {
        // 新的api，使用HTMLDocument.attachShadow创建shadowRoot，mode设置open创建的影子dom可以通过HTMLDocument.shadowRoot访问到
        // 设置为closed，则访问不到(返回null)
        shadow = appElement.attachShadow({ mode: 'open' });
      } else {
        // createShadowRoot was proposed in initial spec, which has then been deprecated
        // 老的api，使用HTMLDocument.createShadowRoot创建shadowRoot
        shadow = (appElement as any).createShadowRoot();
      }
      // 微应用dom挂载到影子dom上
      shadow.innerHTML = innerHTML;
    }
  }

  // 使用启用作用域样式隔离，遍历所有样式(style样式标签)，增加作用域前缀(data-qiankun)
  if (scopedCSS) {
    const attr = appElement.getAttribute(css.QiankunCSSRewriteAttr);
    if (!attr) {
      appElement.setAttribute(css.QiankunCSSRewriteAttr, appName);
    }

    const styleNodes = appElement.querySelectorAll('style') || [];
    forEach(styleNodes, (stylesheetElement: HTMLStyleElement) => {
      css.process(appElement!, stylesheetElement, appName);
    });
  }

  return appElement;
}

/** generate app wrapper dom getter */
function getAppWrapperGetter(
  appName: string,
  appInstanceId: string,
  useLegacyRender: boolean,
  strictStyleIsolation: boolean,
  scopedCSS: boolean,
  elementGetter: () => HTMLElement | null,
) {
  return () => {
    if (useLegacyRender) {
      if (strictStyleIsolation) throw new QiankunError('strictStyleIsolation can not be used with legacy render!');
      if (scopedCSS) throw new QiankunError('experimentalStyleIsolation can not be used with legacy render!');

      const appWrapper = document.getElementById(getWrapperId(appInstanceId));
      assertElementExist(appWrapper, `Wrapper element for ${appName} with instance ${appInstanceId} is not existed!`);
      return appWrapper!;
    }

    const element = elementGetter();
    assertElementExist(element, `Wrapper element for ${appName} with instance ${appInstanceId} is not existed!`);

    if (strictStyleIsolation && supportShadowDOM) {
      return element!.shadowRoot!;
    }

    return element!;
  };
}

const rawAppendChild = HTMLElement.prototype.appendChild;
const rawRemoveChild = HTMLElement.prototype.removeChild;
type ElementRender = (
  props: { element: HTMLElement | null; loading: boolean; container?: string | HTMLElement },
  phase: 'loading' | 'mounting' | 'mounted' | 'unmounted',
) => any;

/**
 * Get the render function
 * If the legacy render function is provide, used as it, otherwise we will insert the app element to target container by qiankun
 * @param appName
 * @param appContent
 * @param legacyRender
 */
function getRender(appName: string, appContent: string, legacyRender?: HTMLContentRender) {
  const render: ElementRender = ({ element, loading, container }, phase) => {
    if (legacyRender) {
      if (process.env.NODE_ENV === 'development') {
        console.warn(
          '[qiankun] Custom rendering function is deprecated, you can use the container element setting instead!',
        );
      }

      return legacyRender({ loading, appContent: element ? appContent : '' });
    }

    const containerElement = getContainer(container!);

    // The container might have be removed after micro app unmounted.
    // Such as the micro app unmount lifecycle called by a react componentWillUnmount lifecycle, after micro app unmounted, the react component might also be removed
    if (phase !== 'unmounted') {
      const errorMsg = (() => {
        switch (phase) {
          case 'loading':
          case 'mounting':
            return `Target container with ${container} not existed while ${appName} ${phase}!`;

          case 'mounted':
            return `Target container with ${container} not existed after ${appName} ${phase}!`;

          default:
            return `Target container with ${container} not existed while ${appName} rendering!`;
        }
      })();
      assertElementExist(containerElement, errorMsg);
    }

    if (containerElement && !containerElement.contains(element)) {
      // clear the container
      while (containerElement!.firstChild) {
        rawRemoveChild.call(containerElement, containerElement!.firstChild);
      }

      // append the element to container if it exist
      if (element) {
        rawAppendChild.call(containerElement, element);
      }
    }

    return undefined;
  };

  return render;
}

function getLifecyclesFromExports(
  scriptExports: LifeCycles<any>,
  appName: string,
  global: WindowProxy,
  globalLatestSetProp?: PropertyKey | null,
) {
  if (validateExportLifecycle(scriptExports)) {
    return scriptExports;
  }

  // fallback to sandbox latest set property if it had
  if (globalLatestSetProp) {
    const lifecycles = (<any>global)[globalLatestSetProp];
    if (validateExportLifecycle(lifecycles)) {
      return lifecycles;
    }
  }

  if (process.env.NODE_ENV === 'development') {
    console.warn(
      `[qiankun] lifecycle not found from ${appName} entry exports, fallback to get from window['${appName}']`,
    );
  }

  // fallback to global variable who named with ${appName} while module exports not found
  const globalVariableExports = (global as any)[appName];

  if (validateExportLifecycle(globalVariableExports)) {
    return globalVariableExports;
  }

  throw new QiankunError(`You need to export lifecycle functions in ${appName} entry`);
}

let prevAppUnmountedDeferred: Deferred<void>;

export type ParcelConfigObjectGetter = (remountContainer?: string | HTMLElement) => ParcelConfigObject;

// 加载微应用
export async function loadApp<T extends ObjectType>(
  app: LoadableApp<T>,
  configuration: FrameworkConfiguration = {},
  lifeCycles?: FrameworkLifeCycles<T>,
): Promise<ParcelConfigObjectGetter> {
  const { entry, name: appName } = app;
  // 生成微应用实例ID
  const appInstanceId = `${appName}_${+new Date()}_${Math.floor(Math.random() * 1000)}`;

  const markName = `[qiankun] App ${appInstanceId} Loading`;
  if (process.env.NODE_ENV === 'development') {
    performanceMark(markName);
  }

  // 获取配置信息(多实例、沙盒等)
  const { singular = false, sandbox = true, excludeAssetFilter, ...importEntryOpts } = configuration;

  // get the entry html content and script executor
  // 使用import-html-entry加载微应用
  /**
   * import-html-entry的执行过程：
   * 1、使用fetch下载entry地址html模板
   * 2、生成一个assetPublicPath变量，用来获取资源基路径，这个是从1中的输入参数entry解析出来的，比如:http://localhost:1111
   *    模板中原始的资源地址一般都是相对地址，这一步需要使用这个方法把模板的资源地址全部改为完整的url，否则在微应用加载时会读取
   *    基座地址导致资源找不到，但是仅仅模板被替换了，js脚本里的资源地址没有被替换，还要结合webpack动态设置publicPath，
   *    在子应用的main.js中加入代码:__webpack_public_path__ = window.__INJECTED_PUBLIC_PATH_BY_QIANKUN__;
   *    这样脚本运行时publicPath就会被qiankun注入的全局变量替换掉，这个全局变量其实就是assetPublicPath，见src/addons/runtimePublicPath.ts
   * 3、生成一个脚本数组，解析出html的外部脚本(script,link)将地址放入数组中，解析出html的内联脚本将内容放入数组，
   *    顺序由html中脚本的出现的位置决定，最后一个脚本标记为入口脚本，然后将1中html的内联脚本和外部脚本引用全部去掉，
   *    这步处理之后html已经没有任何js脚本了，最后返回一个getExternalScripts方法，用来下载和缓存html中所有外部脚本和内联脚本。
   * 4、生成一个样式数组，解析出html的所有外部样式link将地址放入数组中(内联样式不处理)，然后将1中html的外联样式引用全部去掉，
   *    这步处理之后html已经没有任何外联样式了，但内联样式还在，最后返回一个getExternalStyleSheets的方法，用来下载和缓存所有外部样式。
   * 5、模板外联样式处理，使用3中生成的getExternalStyleSheets方法下载所有外部样式，并将样式内嵌到1中的html，这步处理之后
   *    html中的外部样式已全部改为内嵌。
   * 6、返回处理后的html模板(template)，模板已经去掉所有js脚本，资源路径已修改为完整地址，内联样式保留，外部样式已全部加载并
   *    整合为内联样式。
   * 7、生成一个execScripts方法，用来下载、缓存、执行模板中去掉的js脚本。
   * 
   * execScripts的执行过程：
   * 1、使用fetch并行加载上一节3中生成脚本数组，内联脚本不用加载直接读取内容。
   * 2、脚本处理，如果启用了沙箱会生成window代理对象，用来隔离原始的window，这时候需要使用with语句包裹脚本，使脚本的执行上下文
   *    变成沙箱代理。
   * 3、按数组顺序依次调用eval函数动态执行脚本，脚本执行完成后(遇到了入口脚本就是执行完成了)，导出入口脚本模块。
   * 
   */
  const { template, execScripts, assetPublicPath } = await importEntry(entry, importEntryOpts);

  // as single-spa load and bootstrap new app parallel with other apps unmounting
  // (see https://github.com/CanopyTax/single-spa/blob/master/src/navigation/reroute.js#L74)
  // we need wait to load the app until all apps are finishing unmount in singular mode
  // 校验是否开启多实例模式，如果是单实例，需要等到前一个微应用反激活之后才进行加载
  if (await validateSingularMode(singular, app)) {
    await (prevAppUnmountedDeferred && prevAppUnmountedDeferred.promise);
  }

  // 为微应用模板生成一个容器div
  const appContent = getDefaultTplWrapper(appInstanceId, appName)(template);

  // css隔离，是否启用严格样式隔离
  const strictStyleIsolation = typeof sandbox === 'object' && !!sandbox.strictStyleIsolation;
  const scopedCSS = isEnableScopedCSS(sandbox);
  // 生成微应用dom，创建样式隔离shadowDOM(strictStyleIsolation为true)，增加样式隔离作用域前缀(scopedCSS为true)
  let initialAppWrapperElement: HTMLElement | null = createElement(
    appContent,
    strictStyleIsolation,
    scopedCSS,
    appName,
  );

  const initialContainer = 'container' in app ? app.container : undefined;
  const legacyRender = 'render' in app ? app.render : undefined;
  
  // 获取自定义dom的render函数
  const render = getRender(appName, appContent, legacyRender);

  // 第一次加载设置应用可见区域 dom 结构
  // 确保每次应用加载前容器 dom 结构已经设置完毕
  // 将htmlContent的元素挂载到container中，如果container中已经有子元素，先清空再挂载
  render({ element: initialAppWrapperElement, loading: true, container: initialContainer }, 'loading');

  const initialAppWrapperGetter = getAppWrapperGetter(
    appName,
    appInstanceId,
    !!legacyRender,
    strictStyleIsolation,
    scopedCSS,
    () => initialAppWrapperElement,
  );

  let global = window;
  let mountSandbox = () => Promise.resolve();
  let unmountSandbox = () => Promise.resolve();
  const useLooseSandbox = typeof sandbox === 'object' && !!sandbox.loose;
  let sandboxContainer;
  if (sandbox) {
    // 创建js沙箱(3种沙箱模式:LegacySandbox、ProxySandbox、SnapshotSandbox)
    sandboxContainer = createSandboxContainer(
      appName,
      // FIXME should use a strict sandbox logic while remount, see https://github.com/umijs/qiankun/issues/518
      initialAppWrapperGetter,
      scopedCSS,
      useLooseSandbox,
      excludeAssetFilter,
    );
    // 用沙箱的代理对象作为接下来使用的全局对象
    global = sandboxContainer.instance.proxy as typeof window;
    mountSandbox = sandboxContainer.mount; //沙箱启动
    unmountSandbox = sandboxContainer.unmount; // 沙箱卸载
  }

  // 在生命周期钩子中增加qianku标志字段(__POWERED_BY_QIANKUN__,__INJECTED_PUBLIC_PATH_BY_QIANKUN__)的添加和移除
  // 这样在钩子函数随着微应用激活反激活时被自动调用时，标志字段会自动添加和移除
  const {
    beforeUnmount = [],
    afterUnmount = [],
    afterMount = [],
    beforeMount = [],
    beforeLoad = [],
  } = mergeWith({}, getAddOns(global, assetPublicPath), lifeCycles, (v1, v2) => concat(v1 ?? [], v2 ?? []));
  
  // 执行beforeLoad生命周期钩子
  await execHooksChain(toArray(beforeLoad), app, global);

  // get the lifecycle hooks from module exports
  // 执行微应用脚本,执行过程见importEntry的注释,获取微应用生命周期函数(bootstrap, mount, unmount, update)
  const scriptExports: any = await execScripts(global, sandbox && !useLooseSandbox);
  const { bootstrap, mount, unmount, update } = getLifecyclesFromExports(
    scriptExports,
    appName,
    global,
    sandboxContainer?.instance?.latestSetProp,
  );

  // 初始化微应用消息通信
  const { onGlobalStateChange, setGlobalState, offGlobalStateChange }: Record<string, CallableFunction> =
    getMicroAppStateActions(appInstanceId);

  // FIXME temporary way
  const syncAppWrapperElement2Sandbox = (element: HTMLElement | null) => (initialAppWrapperElement = element);

  const parcelConfigGetter: ParcelConfigObjectGetter = (remountContainer = initialContainer) => {
    let appWrapperElement: HTMLElement | null;
    let appWrapperGetter: ReturnType<typeof getAppWrapperGetter>;

    // 生成包装过的微应用生命周期函数(沙盒启动卸载，生命周期钩子等包装)
    const parcelConfig: ParcelConfigObject = {
      name: appInstanceId,
      bootstrap,
      mount: [
        async () => {
          if (process.env.NODE_ENV === 'development') {
            const marks = performanceGetEntriesByName(markName, 'mark');
            // mark length is zero means the app is remounting
            if (marks && !marks.length) {
              performanceMark(markName);
            }
          }
        },
        async () => {
          // 加载前等待上一个微应用卸载
          if ((await validateSingularMode(singular, app)) && prevAppUnmountedDeferred) {
            return prevAppUnmountedDeferred.promise;
          }

          return undefined;
        },
        // initial wrapper element before app mount/remount
        // 生成微应用挂载容器
        async () => {
          appWrapperElement = initialAppWrapperElement;
          appWrapperGetter = getAppWrapperGetter(
            appName,
            appInstanceId,
            !!legacyRender,
            strictStyleIsolation,
            scopedCSS,
            () => appWrapperElement,
          );
        },
        // 添加 mount hook, 确保每次应用加载前容器 dom 结构已经设置完毕
        async () => {
          const useNewContainer = remountContainer !== initialContainer;
          if (useNewContainer || !appWrapperElement) {
            // element will be destroyed after unmounted, we need to recreate it if it not exist
            // or we try to remount into a new container
            appWrapperElement = createElement(appContent, strictStyleIsolation, scopedCSS, appName);
            syncAppWrapperElement2Sandbox(appWrapperElement);
          }
          // 重新激活时，需要将htmlContent重新挂载到微应用container中
          render({ element: appWrapperElement, loading: true, container: remountContainer }, 'mounting');
        },
        // 启动沙盒
        mountSandbox,
        // exec the chain after rendering to keep the behavior with beforeLoad
        // 执行beforeMount
        async () => execHooksChain(toArray(beforeMount), app, global),
        // 执行微应用mount函数
        async (props) => mount({ ...props, container: appWrapperGetter(), setGlobalState, onGlobalStateChange }),
        // finish loading after app mounted
        async () => render({ element: appWrapperElement, loading: false, container: remountContainer }, 'mounted'),
        // 执行afterMount
        async () => execHooksChain(toArray(afterMount), app, global),
        // initialize the unmount defer after app mounted and resolve the defer after it unmounted
        async () => {
          if (await validateSingularMode(singular, app)) {
            prevAppUnmountedDeferred = new Deferred<void>();
          }
        },
        async () => {
          if (process.env.NODE_ENV === 'development') {
            const measureName = `[qiankun] App ${appInstanceId} Loading Consuming`;
            performanceMeasure(measureName, markName);
          }
        },
      ],
      unmount: [
        // 执行beforeUnmount
        async () => execHooksChain(toArray(beforeUnmount), app, global),
        // 执行微应用unmount函数
        async (props) => unmount({ ...props, container: appWrapperGetter() }),
        // 卸载沙盒
        unmountSandbox,
        // 执行afterUnmount
        async () => execHooksChain(toArray(afterUnmount), app, global),
        // 卸载微应用通信组件
        async () => {
          render({ element: null, loading: false, container: remountContainer }, 'unmounted');
          offGlobalStateChange(appInstanceId);
          // for gc
          appWrapperElement = null;
          syncAppWrapperElement2Sandbox(appWrapperElement);
        },
        async () => {
          if ((await validateSingularMode(singular, app)) && prevAppUnmountedDeferred) {
            prevAppUnmountedDeferred.resolve();
          }
        },
      ],
    };

    if (typeof update === 'function') {
      parcelConfig.update = update;
    }

    return parcelConfig;
  };

  return parcelConfigGetter;
}
