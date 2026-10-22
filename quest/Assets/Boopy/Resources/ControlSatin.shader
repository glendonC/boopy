Shader "Boopy/ControlSatin"
{
    Properties
    {
        _Color ("Matte pigment", Color) = (.141176,.149020,.156863,1)
        _SurfaceSize ("Physical face and bevel", Vector) = (.12,.06,.014,0)
        _Press ("Pressed relief", Range(0,1)) = 0
    }
    SubShader
    {
        Tags { "Queue"="Transparent" "RenderType"="Transparent" }
        Blend SrcAlpha OneMinusSrcAlpha
        Cull Off
        ZWrite Off
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 3.0
            #pragma multi_compile_instancing
            #include "UnityCG.cginc"
            struct appdata { float4 vertex : POSITION; UNITY_VERTEX_INPUT_INSTANCE_ID };
            struct v2f { float4 vertex : SV_POSITION; float2 local : TEXCOORD0; UNITY_VERTEX_OUTPUT_STEREO };
            float4 _Color, _SurfaceSize;
            float _Press;
            v2f vert(appdata input)
            {
                v2f output;
                UNITY_SETUP_INSTANCE_ID(input);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(output);
                output.vertex = UnityObjectToClipPos(input.vertex);
                output.local = input.vertex.xy;
                return output;
            }
            fixed4 frag(v2f input) : SV_Target
            {
                UNITY_SETUP_STEREO_EYE_INDEX_POST_VERTEX(input);
                // A restrained neutral matte response; hover belongs to the whole control fill.
                float key=.99+input.local.y*.018;
                float3 color=_Color.rgb*(key-_Press*.035);
                return fixed4(color,_Color.a);
            }
            ENDCG
        }
    }
}
