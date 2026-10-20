import { describe, it, expect } from 'vitest';
import { allGranted, backgroundBannerText, permissionButtonLabel } from './permissionUi';

describe('permissionButtonLabel', () => {
  it('hides the button once granted', () => {
    expect(permissionButtonLabel(true)).toBeNull();
  });
  it('escalates from Allow to Try again to Open settings', () => {
    expect(permissionButtonLabel(false)).toBe('Allow');
    expect(permissionButtonLabel(false, 'denied')).toBe('Try again');
    expect(permissionButtonLabel(false, 'blocked')).toBe('Open settings');
  });
});

describe('allGranted', () => {
  it('requires every permission', () => {
    expect(allGranted({ notifications: true, battery: true, camera: true })).toBe(true);
    expect(allGranted({ notifications: true, battery: false, camera: true })).toBe(false);
  });
});

describe('backgroundBannerText', () => {
  it('is hidden when notifications and battery are allowed (camera does not matter)', () => {
    expect(backgroundBannerText({ notifications: true, battery: true, camera: false })).toBeNull();
  });
  it('names what is missing', () => {
    expect(
      backgroundBannerText({ notifications: false, battery: true, camera: true })!.body
    ).toContain('Allow notifications so');
    expect(
      backgroundBannerText({ notifications: false, battery: false, camera: true })!.body
    ).toContain('notifications and battery access');
  });
});
