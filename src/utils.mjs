class fakeMap_Alltrue{
    get(){return true}
    set(){}
    has(){return true}
    constructor(){}
}

class fixedRing{
    ring=undefined;
    pointer=0;
    constructor(leng){
        let length=1 << Math.round(Math.log2(leng));
        this.ring=Array(length);
        this.bitmask=length-1;
    }
    push(obj){
        this.ring[this.pointer]=obj;
        this.pointer=(this.pointer+1) & this.bitmask;
    }
}

export {
    fakeMap_Alltrue,
    fixedRing
}
