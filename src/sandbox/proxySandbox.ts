/* eslint-disable no-param-reassign */
/**
 * @author Kuitos
 * @since 2020-3-31
 */
import type { SandBox } from '../interfaces';
import { SandBoxType } from '../interfaces';
import { nextTask } from '../utils';
import { getTargetValue, setCurrentRunningSandboxProxy } from './common';

/**
 * fastest(at most time) unique array method
 * @see https://jsperf.com/array-filter-unique/30
 */
function uniq(array: Array<string | symbol>) {
  return array.filter(function filter(this: PropertyKey[], element) {
    return element in this ? false : ((this as any)[element] = true);
  }, Object.create(null));
}

// zone.js will overwrite Object.defineProperty
const rawObjectDefineProperty = Object.defineProperty;

const variableWhiteListInDev =
  process.env.NODE_ENV === 'development' || window.__QIANKUN_DEVELOPMENT__
    ? [
      // for react hot reload
      // see https://github.com/facebook/create-react-app/blob/66bf7dfc43350249e2f09d138a20840dae8a0a4a/packages/react-error-overlay/src/index.js#L180
      '__REACT_ERROR_OVERLAY_GLOBAL_HOOK__',
    ]
    : [];
// who could escape the sandbox
const variableWhiteList: PropertyKey[] = [
  // FIXME System.js used a indirect call with eval, which would make it scope escape to global
  // To make System.js works well, we write it back to global window temporary
  // see https://github.com/systemjs/systemjs/blob/457f5b7e8af6bd120a279540477552a07d5de086/src/evaluate.js#L106
  'System',

  // see https://github.com/systemjs/systemjs/blob/457f5b7e8af6bd120a279540477552a07d5de086/src/instantiate.js#L357
  '__cjsWrapper',
  ...variableWhiteListInDev,
];

/*
 variables who are impossible to be overwrite need to be escaped from proxy sandbox for performance reasons
 */
const unscopables = {
  undefined: true,
  Array: true,
  Object: true,
  String: true,
  Boolean: true,
  Math: true,
  Number: true,
  Symbol: true,
  parseFloat: true,
  Float32Array: true,
};

type SymbolTarget = 'target' | 'rawWindow';

type FakeWindow = Window & Record<PropertyKey, any>;

// 复制window中不可配置(configurable)的属性到fakeWindow，包括window、document、location、top等属性
function createFakeWindow(global: Window) {
  // map always has the fastest performance in has check scenario
  // see https://jsperf.com/array-indexof-vs-set-has/23
  const propertiesWithGetter = new Map<PropertyKey, boolean>();
  const fakeWindow = {} as FakeWindow;

  /*
   copy the non-configurable property of global to fakeWindow
   see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/handler/getOwnPropertyDescriptor
   > A property cannot be reported as non-configurable, if it does not exists as an own property of the target object or if it exists as a configurable own property of the target object.
   */
  Object.getOwnPropertyNames(global)
    .filter((p) => {
      const descriptor = Object.getOwnPropertyDescriptor(global, p);
      return !descriptor?.configurable;
    })
    .forEach((p) => {
      const descriptor = Object.getOwnPropertyDescriptor(global, p);
      if (descriptor) {
        const hasGetter = Object.prototype.hasOwnProperty.call(descriptor, 'get');

        /*
         make top/self/window property configurable and writable, otherwise it will cause TypeError while get trap return.
         see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/handler/get
         > The value reported for a property must be the same as the value of the corresponding target object property if the target object property is a non-writable, non-configurable data property.
         */
        if (
          p === 'top' ||
          p === 'parent' ||
          p === 'self' ||
          p === 'window' ||
          (process.env.NODE_ENV === 'test' && (p === 'mockTop' || p === 'mockSafariTop'))
        ) {
          descriptor.configurable = true;
          /*
           The descriptor of window.window/window.top/window.self in Safari/FF are accessor descriptors, we need to avoid adding a data descriptor while it was
           Example:
            Safari/FF: Object.getOwnPropertyDescriptor(window, 'top') -> {get: function, set: undefined, enumerable: true, configurable: false}
            Chrome: Object.getOwnPropertyDescriptor(window, 'top') -> {value: Window, writable: false, enumerable: true, configurable: false}
           */
          if (!hasGetter) {
            descriptor.writable = true;
          }
        }

        // 可以获取值的属性方法此列表中，如window、document、location、top
        if (hasGetter) propertiesWithGetter.set(p, true);

        // freeze the descriptor to avoid being modified by zone.js
        // see https://github.com/angular/zone.js/blob/a5fe09b0fac27ac5df1fa746042f96f05ccb6a00/lib/browser/define-property.ts#L71
        rawObjectDefineProperty(fakeWindow, p, Object.freeze(descriptor));
      }
    });

  return {
    fakeWindow,
    propertiesWithGetter,
  };
}

// 激活的沙盒数量，因为可以同时激活多个沙箱
let activeSandboxCount = 0;

/**
 * 基于 Proxy 实现的沙箱
 * 这个沙箱将新增或修改的值仅仅放在fakeWindow里面，所以它可以运行多个沙箱同时运行而不污染原始对象
 * 这点与SingularProxySandbox不一样，功能更强大
 */
export default class ProxySandbox implements SandBox {
  /** window 值变更记录 */
  private updatedValueSet = new Set<PropertyKey>();

  name: string;

  type: SandBoxType;

  proxy: WindowProxy;

  sandboxRunning = true;

  latestSetProp: PropertyKey | null = null;

  active() {
    if (!this.sandboxRunning) activeSandboxCount++;
    this.sandboxRunning = true;
  }

  inactive() {
    if (process.env.NODE_ENV === 'development') {
      console.info(`[qiankun:sandbox] ${this.name} modified global properties restore...`, [
        ...this.updatedValueSet.keys(),
      ]);
    }

    if (--activeSandboxCount === 0) {
      variableWhiteList.forEach((p) => {
        if (this.proxy.hasOwnProperty(p)) {
          // @ts-ignore
          delete window[p];
        }
      });
    }

    this.sandboxRunning = false;
  }

  constructor(name: string) {
    this.name = name;
    this.type = SandBoxType.Proxy;
    const { updatedValueSet } = this;

    const rawWindow = window;
    const { fakeWindow, propertiesWithGetter } = createFakeWindow(rawWindow);

    // 用来缓存属性存放的位置，是rawWindow还是fakeWindow，加快检索速度
    const descriptorTargetMap = new Map<PropertyKey, SymbolTarget>();
    // 重写hasOwnProperty，合并2个window的检索结果
    const hasOwnProperty = (key: PropertyKey) => fakeWindow.hasOwnProperty(key) || rawWindow.hasOwnProperty(key);

    // 创建window代理对象
    const proxy = new Proxy(fakeWindow, {
      set: (target: FakeWindow, p: PropertyKey, value: any): boolean => {
        if (this.sandboxRunning) {
          // We must kept its description while the property existed in rawWindow before
          // 原始window有但是fakeWindow没有的属性，将属性描述拷贝到fakeWindow
          if (!target.hasOwnProperty(p) && rawWindow.hasOwnProperty(p)) {
            const descriptor = Object.getOwnPropertyDescriptor(rawWindow, p);
            const { writable, configurable, enumerable } = descriptor!;
            if (writable) {
              Object.defineProperty(target, p, {
                configurable,
                enumerable,
                writable,
                value,
              });
            }
          } else {
            // @ts-ignore
            // 原始window没有的属性，即新增的属性，直接写到fakeWindow里面，
            // 直接赋值的隐式属性描述符是(configurable:true,enumerable:true,writable:true,value:value)
            // 这里不会将值写到原始window对象
            target[p] = value;
          }

          if (variableWhiteList.indexOf(p) !== -1) {
            // @ts-ignore
            rawWindow[p] = value;
          }

          // 新增或修改的值记录到此列表
          updatedValueSet.add(p);

          this.latestSetProp = p;

          return true;
        }

        if (process.env.NODE_ENV === 'development') {
          console.warn(`[qiankun] Set window.${p.toString()} while sandbox destroyed or inactive in ${name}!`);
        }

        // 在 strict-mode 下，Proxy 的 handler.set 返回 false 会抛出 TypeError，在沙箱卸载的情况下应该忽略错误
        return true;
      },
      // document、location、非顶层窗口的top属性、hasOwnProperty、eval这几个属性直接返回的原始window的属性，
      // 特别是使用document.addEventListener等方法时要注意在微应用卸载时手动清理
      get(target: FakeWindow, p: PropertyKey): any {
        if (p === Symbol.unscopables) return unscopables;

        setCurrentRunningSandboxProxy(proxy);
        // FIXME if you have any other good ideas
        // remove the mark in next tick, thus we can identify whether it in micro app or not
        // this approach is just a workaround, it could not cover all complex cases, such as the micro app runs in the same task context with master in some case
        nextTask(() => setCurrentRunningSandboxProxy(null));

        // avoid who using window.window or window.self to escape the sandbox environment to touch the really window
        // see https://github.com/eligrey/FileSaver.js/blob/master/src/FileSaver.js#L13
        if (p === 'window' || p === 'self') {
          return proxy;
        }

        // hijack global accessing with globalThis keyword
        if (p === 'globalThis') {
          return proxy;
        }

        // 顶层窗口返回代理，否则返回原始window的top或parent
        if (
          p === 'top' ||
          p === 'parent' ||
          (process.env.NODE_ENV === 'test' && (p === 'mockTop' || p === 'mockSafariTop'))
        ) {
          // if your master app in an iframe context, allow these props escape the sandbox
          if (rawWindow === rawWindow.parent) {
            return proxy;
          }
          return (rawWindow as any)[p];
        }

        // proxy.hasOwnProperty would invoke getter firstly, then its value represented as rawWindow.hasOwnProperty
        if (p === 'hasOwnProperty') {
          return hasOwnProperty;
        }

        // mark the symbol to document while accessing as document.createElement could know is invoked by which sandbox for dynamic append patcher
        if (p === 'document' || p === 'eval') {
          switch (p) {
            case 'document':
              return document;
            case 'eval':
              // eslint-disable-next-line no-eval
              return eval;
            // no default
          }
        }

        // eslint-disable-next-line no-nested-ternary
        // 先从rawWindow中获取，获取不到再到fakeWindow中获取
        const value = propertiesWithGetter.has(p)
          ? (rawWindow as any)[p]
          : p in target
            ? (target as any)[p]
            : (rawWindow as any)[p];
        return getTargetValue(rawWindow, value);
      },

      // trap in operator
      // see https://github.com/styled-components/styled-components/blob/master/packages/styled-components/src/constants.js#L12
      has(target: FakeWindow, p: string | number | symbol): boolean {
        // 判断属性是否存在先从fakeWindow中获取再从rawWindow中获取
        return p in unscopables || p in target || p in rawWindow;
      },

      getOwnPropertyDescriptor(target: FakeWindow, p: string | number | symbol): PropertyDescriptor | undefined {
        /*
         as the descriptor of top/self/window/mockTop in raw window are configurable but not in proxy target, we need to get it from target to avoid TypeError
         see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/handler/getOwnPropertyDescriptor
         > A property cannot be reported as non-configurable, if it does not exists as an own property of the target object or if it exists as a configurable own property of the target object.
         */
        if (target.hasOwnProperty(p)) {
          const descriptor = Object.getOwnPropertyDescriptor(target, p);
          descriptorTargetMap.set(p, 'target');
          return descriptor;
        }

        if (rawWindow.hasOwnProperty(p)) {
          const descriptor = Object.getOwnPropertyDescriptor(rawWindow, p);
          descriptorTargetMap.set(p, 'rawWindow');
          // A property cannot be reported as non-configurable, if it does not exists as an own property of the target object
          if (descriptor && !descriptor.configurable) {
            descriptor.configurable = true;
          }
          return descriptor;
        }

        return undefined;
      },

      // trap to support iterator with sandbox
      ownKeys(target: FakeWindow): ArrayLike<string | symbol> {
        // 合并rawWindow和fakeWindow的属性集合再去重
        return uniq(Reflect.ownKeys(rawWindow).concat(Reflect.ownKeys(target)));
      },

      defineProperty(target: Window, p: PropertyKey, attributes: PropertyDescriptor): boolean {
        // 判断属性是来源于rawWindow还是fakeWindow,再调用对应window的方法
        const from = descriptorTargetMap.get(p);
        /*
         Descriptor must be defined to native window while it comes from native window via Object.getOwnPropertyDescriptor(window, p),
         otherwise it would cause a TypeError with illegal invocation.
         */
        switch (from) {
          case 'rawWindow':
            return Reflect.defineProperty(rawWindow, p, attributes);
          default:
            return Reflect.defineProperty(target, p, attributes);
        }
      },
      // 对于删除的属性，只会从fakeWindow中清除，rawWindow因为不会被修改，所以不用处理
      deleteProperty(target: FakeWindow, p: string | number | symbol): boolean {
        if (target.hasOwnProperty(p)) {
          // @ts-ignore
          delete target[p];
          updatedValueSet.delete(p);

          return true;
        }

        return true;
      },

      // makes sure `window instanceof Window` returns truthy in micro app
      getPrototypeOf() {
        return Reflect.getPrototypeOf(rawWindow);
      },
    });

    this.proxy = proxy;

    activeSandboxCount++;
  }
}
