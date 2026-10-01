import Homey from 'homey';

export default class CandelaApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Yeelight Candela Bluetooth app initialized');
  }

}
