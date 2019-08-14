/* global chrome */
import { EventEmitter } from "events";

export default class UDPSocket extends EventEmitter{
  public connected:boolean;
  private udp:any;
  private info:any;
  private host:string;
  private port:number;

  constructor() {
    super();
    this.connected = false;
    this.udp = chrome.sockets.udp;
  }

  public connect(host:string, port:number, errorCallback:any, successCallback:any):void {
    this.host = host;
    this.port = port;
    try {
      this.udp.create({}, (_socketInfo) => {
        this.info = _socketInfo;
        this.udp.bind(this.info.socketId, `0.0.0.0`, 0, (result: number) => {
          if (result < 0){
            errorCallback({ result });
            this.connected = false;
            this.emit("close");
          }else{
            this.connected = true;
            this.emit("open");
            this.udp.onReceive.addListener((event:any)=>{
              this.emit("message", event);
            });
            successCallback({ result });
          }
        });
      });
    } catch (error) {
      this.emit("error", error);
    }
  }

  public send(message:any, callback:any):void{
    try {
      const msg: string = message.toString();
      var textEnconder = new TextEncoder(); 
      this.udp.send(this.info.socketId, textEnconder.encode(msg), this.host, this.port, sendResult => {
        if(typeof callback === "function"){
          callback(sendResult);
        }
      });
    } catch (error) {
      this.emit("error", error);
    }
   
  }

  public close(callback:any):void {
    try{
      this.emit("close");
      this.udp.close(this.info.socketId, () =>{
        if(typeof callback === "function"){
          this.connected = false;
          callback();
        }
      });
    }catch (error) {
      this.emit("error", error);
    }
  }

}
