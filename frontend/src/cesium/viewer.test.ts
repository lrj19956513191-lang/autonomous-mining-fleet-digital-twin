import { beforeEach, expect, test, vi } from 'vitest';
import { Color, Ellipsoid, EllipsoidTerrainProvider, SceneMode, type Viewer } from 'cesium';
import { createViewer } from './viewer';

// Keep the DOM widget at its boundary; this suite verifies Viewer ownership.
vi.mock('./zoomControl', () => ({ attachZoomControl: vi.fn(() => ({ destroy: vi.fn() })) }));

type FakeViewer = {
  destroy: ReturnType<typeof vi.fn<() => void>>;
  isDestroyed: ReturnType<typeof vi.fn<() => boolean>>;
  scene: { globe: { baseColor: Color }; screenSpaceCameraController: { zoomFactor: number; inertiaZoom: number } };
};

const { ViewerMock } = vi.hoisted(() => ({
  ViewerMock: vi.fn<(container: HTMLElement, options?: Viewer.ConstructorOptions) => FakeViewer>(),
}));

vi.mock('cesium', async (importOriginal) => ({
  ...await importOriginal<typeof import('cesium')>(),
  Viewer: ViewerMock,
}));

let fakeViewer: FakeViewer;

function makeFakeViewer(): FakeViewer {
  let destroyed = false;
  return {
    destroy: vi.fn(() => {
      if (destroyed) throw new Error('Viewer already destroyed');
      destroyed = true;
    }),
    isDestroyed: vi.fn(() => destroyed),
    scene: { globe: { baseColor: Color.WHITE }, screenSpaceCameraController: { zoomFactor: 5, inertiaZoom: 0.8 } },
  };
}

beforeEach(() => {
  fakeViewer = makeFakeViewer();
  ViewerMock.mockReset();
  ViewerMock.mockImplementation(function () { return fakeViewer; });
});

const container = { id: 'viewer-container' } as HTMLElement;

test('constructs one Viewer using the supplied container', () => {
  createViewer(container);
  expect(ViewerMock).toHaveBeenCalledTimes(1);
  expect(ViewerMock.mock.calls[0][0]).toBe(container);
});

test('uses the approved offline WGS84 3D configuration', () => {
  createViewer(container);
  const options = ViewerMock.mock.calls[0][1];
  expect(options).toMatchObject({
    ellipsoid: Ellipsoid.WGS84,
    sceneMode: SceneMode.SCENE3D,
    scene3DOnly: true,
    baseLayerPicker: false,
    baseLayer: false,
    geocoder: false,
    timeline: false,
    animation: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
  });
  expect(options?.terrainProvider).toBeInstanceOf(EllipsoidTerrainProvider);
  expect(options?.terrainProvider?.tilingScheme.ellipsoid).toBe(Ellipsoid.WGS84);
  expect(options?.requestRenderMode).toBeUndefined();
  expect(options?.useDefaultRenderLoop).toBeUndefined();
  expect(options?.creditContainer).toBeUndefined();
  expect(options?.terrain).toBeUndefined();
});

test('exposes the same Viewer instance returned by the constructor', () => {
  const handle = createViewer(container);
  expect(handle.viewer).toBe(fakeViewer);
});

test('destroys the underlying Viewer on cleanup', () => {
  const handle = createViewer(container);
  handle.destroy();
  expect(fakeViewer.destroy).toHaveBeenCalledTimes(1);
});

test('cleanup is idempotent and does not destroy resources twice', () => {
  const handle = createViewer(container);
  expect(() => { handle.destroy(); handle.destroy(); }).not.toThrow();
  expect(fakeViewer.destroy).toHaveBeenCalledTimes(1);
});

test('sets the globe to a fixed dark opaque color', () => {
  createViewer(container);
  expect(fakeViewer.scene.globe.baseColor).toEqual(Color.DARKSLATEGRAY);
});

test('cleanup safely skips a Viewer already destroyed externally', () => {
  const handle = createViewer(container);
  fakeViewer.destroy();
  expect(() => handle.destroy()).not.toThrow();
  expect(fakeViewer.destroy).toHaveBeenCalledTimes(1);
});

test.each([
  { label: 'the same container', secondContainer: container },
  { label: 'a different container', secondContainer: { id: 'second-viewer-container' } as HTMLElement },
])('separate handles clean up only their own Viewer across setup cleanup setup in $label', ({ secondContainer }) => {
  const firstViewer = fakeViewer;
  const secondViewer = makeFakeViewer();
  ViewerMock.mockImplementationOnce(function () { return firstViewer; })
    .mockImplementationOnce(function () { return secondViewer; });
  const first = createViewer(container);
  first.destroy();
  const second = createViewer(secondContainer);
  first.destroy();
  expect(first.viewer).toBe(firstViewer);
  expect(second.viewer).toBe(secondViewer);
  expect(ViewerMock.mock.calls.map(([element]) => element)).toEqual([container, secondContainer]);
  expect(firstViewer.destroy).toHaveBeenCalledTimes(1);
  expect(secondViewer.destroy).not.toHaveBeenCalled();
  second.destroy();
  expect(secondViewer.destroy).toHaveBeenCalledTimes(1);
});

test('propagates Viewer construction failures to its caller', () => {
  const expected = new Error('Viewer initialization failed');
  ViewerMock.mockImplementationOnce(function () { throw expected; });
  let caught: unknown;
  try { createViewer(container); } catch (error) { caught = error; }
  expect(caught).toBe(expected);
});

test('destroying one of two live handles does not destroy the other Viewer', () => {
  const firstViewer = fakeViewer;
  const secondViewer = makeFakeViewer();
  ViewerMock.mockImplementationOnce(function () { return firstViewer; })
    .mockImplementationOnce(function () { return secondViewer; });
  const first = createViewer(container);
  const second = createViewer({ id: 'other-live-container' } as HTMLElement);
  first.destroy();
  expect(firstViewer.destroy).toHaveBeenCalledTimes(1);
  expect(secondViewer.destroy).not.toHaveBeenCalled();
  second.destroy();
  expect(firstViewer.destroy).toHaveBeenCalledTimes(1);
  expect(secondViewer.destroy).toHaveBeenCalledTimes(1);
});

test('uses fine-grained native zoom with reduced coasting in every Viewer', () => {
  const controller = fakeViewer.scene.screenSpaceCameraController;
  const handle = createViewer(container);
  expect(controller.zoomFactor).toBe(1);
  expect(controller.inertiaZoom).toBe(0.2);
  expect(handle.viewer.scene.screenSpaceCameraController).toBe(controller);
  expect(fakeViewer.destroy).not.toHaveBeenCalled();
});
