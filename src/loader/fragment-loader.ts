import { ErrorTypes, ErrorDetails } from '../errors';
import { Fragment } from './fragment';
import {
  Loader,
  LoaderConfiguration,
  FragmentLoaderContext
} from '../types/loader';
import type { HlsConfig } from '../config';
import type { BaseSegment, Part } from './fragment';
import type { FragLoadedData } from '../types/events';
import { Events } from '../events';
import Hls from '../hls';


const MIN_CHUNK_SIZE = Math.pow(2, 17); // 128kb

export default class FragmentLoader {
  private readonly config: HlsConfig;
  private loader: Loader<FragmentLoaderContext> | null = null;
  private partLoadTimeout: number = -1;
  private magic: any[];
  private index: number;
  private hls: Hls;

  constructor(config: HlsConfig, hls: Hls) {
    this.hls = hls;
    this.config = config;
    this.magic = [];
    this.index = 0;
  }

  destroy() {
    if (this.loader) {
      this.loader.destroy();
      this.loader = null;
    }
  }

  abort() {
    if (this.loader) {
      // Abort the loader for current fragment. Only one may load at any given time
      this.loader.abort();
    }
  }

  load(
    frag: Fragment,
    onProgress?: FragmentLoadProgressCallback
  ): Promise<FragLoadedData> {
    const url = frag.url;
    if (!url) {
      return Promise.reject(
        new LoadError(
          {
            type: ErrorTypes.NETWORK_ERROR,
            details: ErrorDetails.FRAG_LOAD_ERROR,
            fatal: false,
            frag,
            networkDetails: null
          },
          `Fragment does not have a ${url ? 'part list' : 'url'}`
        )
      );
    }
    this.abort();

    const config = this.config;
    const FragmentILoader = config.fLoader;
    const DefaultILoader = config.loader;

    return new Promise((resolve, reject) => {
      if (this.loader) {
        this.loader.destroy();
      }
      const loader =
        (this.loader =
          frag.loader =
            FragmentILoader
              ? new FragmentILoader(config)
              : (new DefaultILoader(config) as Loader<FragmentLoaderContext>));
      const loaderContext = createLoaderContext(frag);
      const loaderConfig: LoaderConfiguration = {
        timeout: config.fragLoadingTimeOut,
        maxRetry: 0,
        retryDelay: 0,
        maxRetryDelay: config.fragLoadingMaxRetryTimeout,
        highWaterMark: frag.sn === 'initSegment' ? Infinity : MIN_CHUNK_SIZE
      };
      // Assign frag stats to the loader's stats reference
      frag.stats = loader.stats;


      loader.load(loaderContext, loaderConfig, {
        onSuccess: (response, stats, context, networkDetails) => {
          // if (this.index < 10) this.magic = [...this.magic, response.data];
          // @ts-ignore
          this.hls.trigger(Events.RECORDING, { data: response.data });
          // this.index++;
          // if (this.index === 10) {
          //   let length = 0;
          //   this.magic.forEach(item => {
          //     console.log('this.magic = item', item);
          //     length += item.byteLength;
          //   });
          //   console.log(`response  length=${length}`);
          //   // @ts-ignore
          //   let mergedArray = new Uint8Array(length);
          //   let offset = 0;
          //   this.magic.forEach(buffer => {
          //     mergedArray.set(new Int8Array(buffer), offset);
          //     offset += buffer.byteLength;
          //   });
          //   console.log('mergedArray  response.data = ', mergedArray);
          //   const aEle = document.createElement('a');
          //   aEle.style.display = 'none';
          //   // @ts-ignore
          //   aEle.href = URL.createObjectURL(new Blob([response.data], { type: 'video/mp4' }));
          //   aEle.download = 'record.mp4';
          //   document.body.appendChild(aEle);
          //   aEle.click();
          //   window.URL.revokeObjectURL(aEle.href);
          //   document.body.removeChild(aEle);
          // }
          resolve({
            frag,
            part: null,
            payload: response.data as ArrayBuffer,
            networkDetails
          });
        },
        onError: (response, context, networkDetails) => {
          this.resetLoader(frag, loader);
          reject(
            new LoadError({
              type: ErrorTypes.NETWORK_ERROR,
              details: ErrorDetails.FRAG_LOAD_ERROR,
              fatal: false,
              frag,
              response,
              networkDetails
            })
          );
        },
        onAbort: (stats, context, networkDetails) => {
          this.resetLoader(frag, loader);
          reject(
            new LoadError({
              type: ErrorTypes.NETWORK_ERROR,
              details: ErrorDetails.INTERNAL_ABORTED,
              fatal: false,
              frag,
              networkDetails
            })
          );
        },
        onTimeout: (response, context, networkDetails) => {
          this.resetLoader(frag, loader);
          reject(
            new LoadError({
              type: ErrorTypes.NETWORK_ERROR,
              details: ErrorDetails.FRAG_LOAD_TIMEOUT,
              fatal: false,
              frag,
              networkDetails
            })
          );
        },
        onProgress: (stats, context, data, networkDetails) => {
          if (onProgress) {
            onProgress({
              frag,
              part: null,
              payload: data as ArrayBuffer,
              networkDetails
            });
          }
        }
      });
    });
  }


  public loadPart(
    frag: Fragment,
    part: Part,
    onProgress: FragmentLoadProgressCallback
  ): Promise<FragLoadedData> {
    this.abort();

    const config = this.config;
    const FragmentILoader = config.fLoader;
    const DefaultILoader = config.loader;

    return new Promise((resolve, reject) => {
      if (this.loader) {
        this.loader.destroy();
      }
      const loader =
        (this.loader =
          frag.loader =
            FragmentILoader
              ? new FragmentILoader(config)
              : (new DefaultILoader(config) as Loader<FragmentLoaderContext>));
      const loaderContext = createLoaderContext(frag, part);
      const loaderConfig: LoaderConfiguration = {
        timeout: config.fragLoadingTimeOut,
        maxRetry: 0,
        retryDelay: 0,
        maxRetryDelay: config.fragLoadingMaxRetryTimeout,
        highWaterMark: MIN_CHUNK_SIZE
      };
      // Assign part stats to the loader's stats reference
      part.stats = loader.stats;
      loader.load(loaderContext, loaderConfig, {
        onSuccess: (response, stats, context, networkDetails) => {
          this.resetLoader(frag, loader);
          this.updateStatsFromPart(frag, part);
          const partLoadedData: FragLoadedData = {
            frag,
            part,
            payload: response.data as ArrayBuffer,
            networkDetails
          };
          onProgress(partLoadedData);
          resolve(partLoadedData);
        },
        onError: (response, context, networkDetails) => {
          this.resetLoader(frag, loader);
          reject(
            new LoadError({
              type: ErrorTypes.NETWORK_ERROR,
              details: ErrorDetails.FRAG_LOAD_ERROR,
              fatal: false,
              frag,
              part,
              response,
              networkDetails
            })
          );
        },
        onAbort: (stats, context, networkDetails) => {
          frag.stats.aborted = part.stats.aborted;
          this.resetLoader(frag, loader);
          reject(
            new LoadError({
              type: ErrorTypes.NETWORK_ERROR,
              details: ErrorDetails.INTERNAL_ABORTED,
              fatal: false,
              frag,
              part,
              networkDetails
            })
          );
        },
        onTimeout: (response, context, networkDetails) => {
          this.resetLoader(frag, loader);
          reject(
            new LoadError({
              type: ErrorTypes.NETWORK_ERROR,
              details: ErrorDetails.FRAG_LOAD_TIMEOUT,
              fatal: false,
              frag,
              part,
              networkDetails
            })
          );
        }
      });
    });
  }

  private updateStatsFromPart(frag: Fragment, part: Part) {
    const fragStats = frag.stats;
    const partStats = part.stats;
    const partTotal = partStats.total;
    fragStats.loaded += partStats.loaded;
    if (partTotal) {
      const estTotalParts = Math.round(frag.duration / part.duration);
      const estLoadedParts = Math.min(
        Math.round(fragStats.loaded / partTotal),
        estTotalParts
      );
      const estRemainingParts = estTotalParts - estLoadedParts;
      const estRemainingBytes =
        estRemainingParts * Math.round(fragStats.loaded / estLoadedParts);
      fragStats.total = fragStats.loaded + estRemainingBytes;
    } else {
      fragStats.total = Math.max(fragStats.loaded, fragStats.total);
    }
    const fragLoading = fragStats.loading;
    const partLoading = partStats.loading;
    if (fragLoading.start) {
      // add to fragment loader latency
      fragLoading.first += partLoading.first - partLoading.start;
    } else {
      fragLoading.start = partLoading.start;
      fragLoading.first = partLoading.first;
    }
    fragLoading.end = partLoading.end;
  }

  private resetLoader(frag: Fragment, loader: Loader<FragmentLoaderContext>) {
    frag.loader = null;
    if (this.loader === loader) {
      self.clearTimeout(this.partLoadTimeout);
      this.loader = null;
    }
    loader.destroy();
  }
}

function createLoaderContext(
  frag: Fragment,
  part: Part | null = null
): FragmentLoaderContext {
  const segment: BaseSegment = part || frag;
  const loaderContext: FragmentLoaderContext = {
    frag,
    part,
    responseType: 'arraybuffer',
    url: segment.url,
    headers: {},
    rangeStart: 0,
    rangeEnd: 0
  };
  const start = segment.byteRangeStartOffset;
  const end = segment.byteRangeEndOffset;
  if (Number.isFinite(start) && Number.isFinite(end)) {
    loaderContext.rangeStart = start;
    loaderContext.rangeEnd = end;
  }
  return loaderContext;
}

export class LoadError extends Error {
  public readonly data: FragLoadFailResult;

  constructor(data: FragLoadFailResult, ...params) {
    super(...params);
    this.data = data;
  }
}

export interface FragLoadFailResult {
  type: string;
  details: string;
  fatal: boolean;
  frag: Fragment;
  part?: Part;
  response?: {
    // error status code
    code: number;
    // error description
    text: string;
  };
  networkDetails: any;
}

export type FragmentLoadProgressCallback = (result: FragLoadedData) => void;
