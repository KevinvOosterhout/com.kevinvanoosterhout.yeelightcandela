import Homey from 'homey';
import CandelaBle from '../../lib/candela-ble.ts';
import CandelaController, { isPattern } from '../../lib/candela-controller.ts';

export default class CandelaDevice extends Homey.Device {

  private controller!: CandelaController;
  private readonly unload = () => {
    this.controller.stop().catch(this.error);
  };

  async onInit() {
    const savedPattern = this.getCapabilityValue('candela_pattern');
    const savedDim = this.getStoreValue('brightness') ?? this.getCapabilityValue('dim');
    this.controller = new CandelaController(
      new CandelaBle(this.homey.ble, this.getData().id, (error) => this.error(error)),
      {
        on: this.getCapabilityValue('onoff') === true,
        dim: typeof savedDim === 'number' && savedDim > 0 && savedDim <= 1 ? savedDim : 0.5,
        pattern: isPattern(savedPattern) ? savedPattern : 'steady',
      },
      {
        state: async (state) => {
          await this.setStoreValue('brightness', state.dim);
          await this.setCapabilityValue('onoff', state.on);
          await this.setCapabilityValue('dim', state.on ? state.dim : 0);
          await this.setCapabilityValue('candela_pattern', state.pattern);
        },
        available: () => this.setAvailable(),
        unavailable: async (error) => {
          this.error('Candela Bluetooth connection failed', error);
          await this.setUnavailable(this.homey.__('errors.bluetooth'));
        },
        setTimeout: (callback, ms) => this.homey.setTimeout(callback, ms),
        clearTimeout: (timer) => this.homey.clearTimeout(timer),
      },
    );
    if (!isPattern(savedPattern)) await this.setCapabilityValue('candela_pattern', 'steady');
    this.registerCapabilityListener('onoff', (value) => this.controller.setPower(value));
    this.registerCapabilityListener('dim', (value) => this.controller.setDim(value));
    this.registerCapabilityListener('candela_pattern', (value) => this.setPattern(value));
    this.homey.on('unload', this.unload);
    // A missing lamp should not prevent the device listeners from being registered.
    await this.controller.start().catch(() => {});
  }

  async setPattern(pattern: string) {
    await this.controller.setPattern(pattern);
  }

  onDeleted() {
    this.homey.removeListener('unload', this.unload);
    this.controller.stop().catch(this.error);
  }

}
